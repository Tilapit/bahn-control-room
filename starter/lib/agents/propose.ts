// add_finding, add_step, propose and resolve: how an Investigator run ends. The agent
// adds the card's findings and option steps one flat call at a time, each checked by
// code as it arrives (its source, its action, the policy table, the look-up it names),
// then propose builds the card. The Verifier checks each claim against the record it
// cites before anyone sees it. Severity, the deadline sentence and the source chips
// are written by code, not the model.

import { randomUUID } from "node:crypto"
import { and, eq, ne } from "drizzle-orm"
import { entriesById, getCase, type TimelineItem } from "../case"
import { now as clockNow } from "../clock"
import { db } from "../db"
import { MODELS } from "../models"
import { describe, gigOf, levelFor, levelForAll, PROPOSABLE, waitsForBackup } from "../policies"
import { orderView } from "../queue"
import { cards, decisions, policies } from "../schema"
import type { CardFinding, CardOption, CardStep } from "../schema"
import { at } from "../time"
import { isSafety, urgency } from "../urgency"
import { writeEntry } from "./entries"
import { findingProblems, textProblems } from "./lint"
import { AGENT_LABEL, emptyDraft, type RunCtx, STEP_PARAM_KEYS, type ToolOutcome } from "./tools"
import { verifyCard } from "./verifier"

type Input = Record<string, unknown>
type DraftOption = { label: string; effect: string; steps: CardStep[] }

const COST_LIMIT_EUR = 500
const MAX_FINDINGS = 7
/** How many times the Verifier may send a card back before its notes go on the card as they are. */
const VERIFIER_ROUNDS = 2
/** Params that must name something a look-up in this run returned. */
const NEEDS_LOOKUP = new Set(["book_ferry", "change_ferry_booking", "book_hotel", "book_driver_travel", "switch_driver", "book_tow", "approve_repair_cost"])

const str = (value: unknown) => typeof value === "string" ? value.trim() : ""

/** A card that is not shown goes back with its problems, and the draft is cleared so the agent sends the whole card again. */
function rejectBack(ctx: RunCtx, problems: string[], summary: string): ToolOutcome {
  ctx.draft = emptyDraft()
  return {
    content: `The card was not shown to anyone. Its findings and steps are cleared. Fix these, then add all findings and steps again and call propose, in one turn:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    summary, isError: true, output: { problems },
  }
}

function addError(ctx: RunCtx, problems: string[], summary: string): ToolOutcome {
  ctx.turnErrors.push(...problems)
  return { content: `Not added:\n${problems.map((problem) => `- ${problem}`).join("\n")}`, summary, isError: true, output: { problems } }
}

export async function addFinding(ctx: RunCtx, input: Input): Promise<ToolOutcome> {
  const text = str(input.text)
  const source = str(input.source)
  const also = str(input.also) || null
  const index = ctx.draft.findings.length
  if (index >= MAX_FINDINGS) return { content: `Not added: the card already has ${MAX_FINDINGS} findings, the most it holds. Keep the most important ones.`, summary: "Finding not added: the card is full", isError: true }
  if (!text) return addError(ctx, ["The finding has no text"], "Finding not added: no text")
  const entryId = ctx.refs.resolve(source)
  const alsoId = also ? ctx.refs.resolve(also) : null
  const entries = await entriesById([entryId, alsoId].filter((id): id is string => !!id))
  const problems = findingProblems(index, { text, source }, entryId ? entries.get(entryId) ?? null : null)
  if (also && !(alsoId && entries.get(alsoId))) problems.push(`Its second source "${also}" is not an entry you were shown`)
  if (problems.length) return addError(ctx, problems.map((problem) => problem.replace(/^Finding \d+ /, "The finding ")), `Finding not added (${problems.length} problem${problems.length === 1 ? "" : "s"})`)
  ctx.draft.findings.push({ text, source, also, entryId: entryId!, alsoId })
  return { content: `Finding ${index + 1} added.`, summary: `Noted a finding: ${text}`, output: { index: index + 1, entryId, alsoId } }
}

export async function addAffected(ctx: RunCtx, input: Input): Promise<ToolOutcome> {
  const reference = str(input.order).toUpperCase()
  const effect = str(input.effect)
  const file = reference ? await getCase(reference) : null
  const problems: string[] = []
  if (!file) problems.push(`There is no order ${reference || "(empty)"}`)
  else if (!ctx.group.includes(file.order.id)) problems.push(`${reference} is not one of the orders this run covers`)
  if (!effect) problems.push("Say in one sentence what the cause means for this order")
  problems.push(...textProblems("The effect", effect))
  if (problems.length) return addError(ctx, problems, "Order not added to the card")
  ctx.draft.affected = [...ctx.draft.affected.filter((item) => item.orderId !== file!.order.id), { orderId: file!.order.id, reference: file!.order.reference, car: file!.order.car.label, effect }]
  return { content: `${reference} is on the card (${ctx.draft.affected.length} of ${ctx.group.length} orders this run covers).`, summary: `Put ${reference} on the card: ${effect}` }
}

export async function addStep(ctx: RunCtx, input: Input): Promise<ToolOutcome> {
  const option = Number(input.option)
  const action = str(input.action)
  const params: Record<string, unknown> = {}
  for (const key of STEP_PARAM_KEYS) {
    const value = input[key]
    if (typeof value === "string" ? value.trim() : value !== undefined && value !== null) params[key] = typeof value === "string" ? value.trim() : value
  }
  const problems: string[] = []
  // On a card for several orders each step names its order; code keeps the id for the Executor.
  if (params.order) {
    const target = await getCase(String(params.order))
    if (!target || !ctx.group.includes(target.order.id)) problems.push(`${String(params.order)} is not one of the orders this run covers`)
    else if (target.order.id === ctx.orderId) delete params.order
    else { params.order = target.order.reference; params.order_id = target.order.id }
  }
  if (![1, 2, 3].includes(option)) problems.push("option must be 1, 2 or 3")
  if (!PROPOSABLE.includes(action)) problems.push(`"${action}" is not an action you can propose`)
  else {
    if (await levelFor(action) === "never") problems.push(`${action} is never allowed right now`)
    if (NEEDS_LOOKUP.has(action)) {
      const lookup = ctx.lookups[str(params.id)]
      if (!lookup) problems.push(`${action} needs an id returned by a look-up in this run ("${str(params.id)}" was not)`)
      else params.lookup = { kind: lookup.kind, label: lookup.label, price_cents: lookup.priceCents, details: lookup.details }
    }
    if (action === "book_ferry") {
      const file = await getCase(String(params.order_id ?? ctx.orderId))
      // A car with a booked crossing gets that booking moved, never a second one beside it.
      if (file?.plan.bookings.some((booking) => booking.kind === "Ferry" && booking.state === "booked")) problems.push("This car already has a booked crossing; use change_ferry_booking to move it, or the car would hold two crossings")
    }
    for (const key of ["text", "to", "name"]) if (typeof params[key] === "string") problems.push(...textProblems(`Its ${key}`, params[key] as string))
  }
  if (problems.length) return addError(ctx, problems, `Step not added (${problems.length} problem${problems.length === 1 ? "" : "s"})`)
  ctx.draft.steps.push({ option, action, params })
  const count = ctx.draft.steps.filter((step) => step.option === option).length
  const lookupLabel = (params.lookup as { label?: string } | undefined)?.label
  const what = `${describe(action)?.label ?? action}${lookupLabel ? `: ${lookupLabel}` : ""}${params.order ? ` (${String(params.order)})` : ""}`
  return { content: `Option ${option}, step ${count} added: ${what}.`, summary: `Option ${option}: ${what}`, output: { option, step: count } }
}

export async function propose(ctx: RunCtx, input: Input): Promise<ToolOutcome> {
  const kind = input.kind === "question" ? "question" : "decision"
  const file = ctx.file ?? await getCase(ctx.orderId)
  if (!file) return rejectBack(ctx, ["The order could not be loaded."], "Could not load the order")
  if (ctx.turnErrors.length) {
    return rejectBack(ctx, [`${ctx.turnErrors.length === 1 ? "One add_finding or add_step call" : `${ctx.turnErrors.length} add_finding or add_step calls`} in this turn failed, so the card would be missing what you meant to put on it: ${ctx.turnErrors.join("; ")}`], "Card held back: a finding or step in the same turn failed")
  }
  const carPrefix = new RegExp(`^${file.order.car.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[:,\\s-]*`, "i")
  const headline = str(input.headline).replace(carPrefix, "")
  const whatHappened = str(input.what_happened)
  const rejectLabel = str(input.reject_label) || "Reject"
  const drafts = ctx.draft.findings
  const options: DraftOption[] = [1, 2, 3]
    .map((n) => ({ n, label: str(input[`option_${n}_label`]), effect: str(input[`option_${n}_effect`]) }))
    .filter((option) => option.label || option.effect || ctx.draft.steps.some((step) => step.option === option.n))
    .map((option) => ({ label: option.label, effect: option.effect, steps: ctx.draft.steps.filter((step) => step.option === option.n).map(({ action, params }) => ({ action, params })) }))
  const problems: string[] = []

  // Shape.
  if (!headline) problems.push("The headline is empty")
  if (headline.length > 80) problems.push(`The headline has ${headline.length} characters; keep it under 70`)
  if (!whatHappened) problems.push("what_happened is empty")
  if (drafts.length < 2) problems.push(`The card has ${drafts.length} finding${drafts.length === 1 ? "" : "s"}; add three to seven with add_finding, in the same turn as propose`)
  if (whatHappened.length > 420) problems.push(`what_happened has ${whatHappened.length} characters; keep it to one or two sentences (under 350); the findings carry the detail`)
  if (!options.length) problems.push("Give at least option 1")
  problems.push(...textProblems("The headline", headline), ...textProblems("what_happened", whatHappened), ...textProblems("The reject label", rejectLabel))
  // One cause, several orders: the card covers every order of the run, each with its effect.
  if (ctx.group.length > 1) {
    const missing = ctx.group.filter((id) => !ctx.draft.affected.some((item) => item.orderId === id))
    if (missing.length) {
      const references = (await Promise.all(missing.map((id) => getCase(id)))).map((item) => item?.order.reference ?? "?")
      problems.push(`This run covers ${ctx.group.length} orders; add_affected_order for ${references.join(", ")} too (say so if it turned out not to be affected)`)
    }
  }
  const slots = [1, 2, 3].filter((n) => str(input[`option_${n}_label`]) || str(input[`option_${n}_effect`]) || ctx.draft.steps.some((step) => step.option === n))
  if (slots.some((n, index) => n !== index + 1)) problems.push("Number the options from 1 without gaps")

  const cited: TimelineItem[] = []
  const citedAlso: (TimelineItem | null)[] = []
  const entries = await entriesById(drafts.flatMap((draft) => [draft.entryId, draft.alsoId]).filter((id): id is string => !!id))
  for (const draft of drafts) {
    cited.push(entries.get(draft.entryId)!)
    citedAlso.push(draft.alsoId ? entries.get(draft.alsoId) ?? null : null)
  }

  // Every option says what it does; a decision option does something. Steps were checked when they were added.
  let computedCostCents = 0
  options.forEach((option, index) => {
    const label = `Option ${index + 1}`
    if (!option.label) problems.push(`${label} has no label`)
    if (!option.effect) problems.push(`${label} has no effect`)
    if (option.label.length > 80) problems.push(`${label}'s label is too long; keep it under 70 characters`)
    problems.push(...textProblems(`${label}'s label`, option.label), ...textProblems(`${label}'s effect`, option.effect))
    if (kind === "decision" && !option.steps.length) problems.push(`${label} has no steps; a decision option must do something: add its actions with add_step (use note to keep the plan)`)
    if (kind === "question" && option.steps.length) problems.push(`${label} has steps, but on a question card each option is an answer with no steps`)
    if (index === 0) for (const step of option.steps) {
      const lookup = step.params.lookup as { price_cents?: number | null } | undefined
      if (lookup?.price_cents && step.action !== "switch_driver") computedCostCents += lookup.price_cents
      if (step.action === "approve_repair_cost") computedCostCents += Math.round(Number(step.params.amount_eur ?? 0) * 100)
    }
  })
  // Nobody answered the run's question: the card says so first, with the time (the Monitor's no-reply rule).
  if (ctx.noReplySince && !new RegExp(`not answering since ${ctx.noReplySince.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(headline)) {
    problems.push(`Nobody has answered since ${ctx.noReplySince}: start the headline with "Driver not answering since ${ctx.noReplySince}" (or "Site not answering since ${ctx.noReplySince}")`)
  }
  // A card that rests on a disruption notice names its source and says nobody on the ground confirmed it (code, not the prompt).
  // Only the disruption rule's trigger names a notice ("Monitor: Rail operator notice reports "…""); the Monitor's other
  // rules (a car not moving, no reply) start runs too, and their cards rest on GPS and messages, not on a notice.
  const fromNotice = /^Monitor: [^"]* reports "/.test(ctx.trigger) || cited.some((entry) => entry.channel === "disruption_feed")
  if (fromNotice) {
    if (!cited.some((entry) => entry.channel === "disruption_feed")) problems.push("This card rests on a disruption notice: add a finding that cites the notice itself, so the person sees who reported it")
    const words = [whatHappened, ...drafts.map((draft) => draft.text)].join(" ")
    if (!/not (yet )?(been )?confirmed|ha(s|ve)n['’]t (yet )?(confirmed|reported)|ha(s|ve) not (yet )?(confirmed|reported)|no driver is booked|unconfirmed/i.test(words)) {
      problems.push("Say on the card that the driver has not confirmed the notice yet (or that no driver is booked): it is the source's report, not a fact on the ground")
    }
  }
  // The current driver's travel waits for a backup's yes (lib/policies.ts): checked per order an option touches.
  for (const [index, option] of options.entries()) {
    const byOrder = new Map<string, string[]>()
    for (const step of option.steps) {
      const orderId = typeof step.params.order_id === "string" ? step.params.order_id : ctx.orderId
      byOrder.set(orderId, [...(byOrder.get(orderId) ?? []), step.action])
    }
    for (const [orderId, actions] of byOrder) {
      const target = orderId === file.order.id ? file : await getCase(orderId)
      const problem = target ? waitsForBackup(actions, gigOf(target)) : null
      if (problem) problems.push(`Option ${index + 1}: ${problem}. Keep the current driver's travel booked: take cancel_driver_travel out of this option, keep the offer to the backup, and say in its effect that the travel is cancelled only once the backup has accepted`)
    }
  }
  const levels = await Promise.all(options.map((option) => levelForAll(option.steps.map((step) => step.action))))
  levels.forEach((level, index) => { if (level === "never") problems.push(`Option ${index + 1} contains an action that is never allowed`) })
  if (problems.length) return rejectBack(ctx, problems, `Card sent back by code checks (${problems.length} problem${problems.length === 1 ? "" : "s"})`)

  // Over €500: the senior model decides (SPEC 7), whatever the agent wrote as the cost.
  const costEur = Math.max(typeof input.cost_eur === "number" ? input.cost_eur : 0, computedCostCents / 100) || null
  if (costEur && costEur > COST_LIMIT_EUR && ctx.model !== MODELS.opus) {
    ctx.draft = emptyDraft()
    return {
      content: `This proposal costs about €${Math.round(costEur)}, over the €${COST_LIMIT_EUR} limit for your model. The case is now with the senior model, with everything done so far. The card was not shown and its findings and steps are cleared. Review the case, then add the findings and steps you stand behind and call propose, in one turn.`,
      summary: `Proposal over €${COST_LIMIT_EUR}; handed to the senior model`, switchModel: { model: MODELS.opus, reason: `The proposal costs about €${Math.round(costEur)}, over €${COST_LIMIT_EUR}.` },
    }
  }

  // The Verifier checks each claim against its source. Two rounds of fixes; after that its notes go on the card.
  const zone = orderView(file).zone
  // What bears on where the car is, cited or not: the driver's messages of the last 12 hours, the last GPS, the terminal estimate.
  const now0 = new Date(file.asOf).getTime()
  const contextIds = [
    ...file.timeline.filter((item) => item.kind === "message" && item.authorType === "driver" && now0 - new Date(item.at).getTime() < 12 * 3600_000).map((item) => item.id),
    ...(file.plan.lastPosition?.source.entryId ? [file.plan.lastPosition.source.entryId] : []),
    ...(file.plan.terminalDrive?.source.entryId ? [file.plan.terminalDrive.source.entryId] : []),
  ]
  const contextEntries = await entriesById(contextIds)
  let verification: Awaited<ReturnType<typeof verifyCard>>
  try {
    verification = await verifyCard({
      headline, whatHappened, rejectLabel, context: [...contextEntries.values()],
      findings: drafts.map((draft, index) => ({ text: draft.text, entry: cited[index], also: citedAlso[index] })),
      options: options.map((option) => ({ label: option.label, effect: option.effect, steps: option.steps.map((step) => `${describe(step.action)?.label ?? step.action}${step.params.lookup ? `: ${(step.params.lookup as { label: string }).label}` : ""}`) })),
    }, zone)
  } catch (cause) {
    // A verifier failure does not stop the card; the card says it was not checked.
    verification = { verdict: "pass", conflict: null, call: null, notes: [{ finding: null, ok: false, note: `The verifier could not check this card (${cause instanceof Error ? cause.message : "error"}).` }] } as unknown as Awaited<ReturnType<typeof verifyCard>>
  }
  ctx.verifierRounds += 1
  if (verification.call) ctx.usageExtra.push({ model: verification.call.model, usage: verification.call.usage, what: "verifier" })

  // Conflicting evidence goes to the senior model (SPEC 7). The agent may have missed it; the verifier's check is enforced here.
  if (verification.conflict && ctx.model !== MODELS.opus) {
    ctx.draft = emptyDraft()
    return {
      content: `The verifier found that two records disagree: ${verification.conflict} Conflicting evidence is handled by the senior model, so the case is now with it, with everything done so far. The card was not shown and its findings and steps are cleared. Review the evidence. If a question to the driver or the site would settle the disagreement, ask it before you propose. On the card, put both statements with their times and the gap between them.`,
      summary: "Verifier found conflicting sources; handed to the senior model", switchModel: { model: MODELS.opus, reason: `Conflicting evidence: ${verification.conflict}` },
    }
  }
  const failing = verification.notes.filter((note) => !note.ok)
  if (verification.verdict === "fix" && failing.length && ctx.verifierRounds <= VERIFIER_ROUNDS) {
    ctx.draft = emptyDraft()
    return {
      content: `The verifier checked each claim against its source and found problems. The card was not shown yet, and its findings and steps are cleared. Fix these, then add all findings and steps again and call propose, in one turn:\n${failing.map((note) => `- ${note.finding != null ? `Finding ${note.finding + 1}: ` : ""}${note.note}`).join("\n")}`,
      summary: `Card sent back by the verifier (${failing.length} problem${failing.length === 1 ? "" : "s"})`, isError: true, output: verification.notes,
    }
  }

  // References of other orders a finding cites (a card for several orders), so its chip opens the right order.
  const otherRefs = new Map<string, string>()
  for (const entry of cited) if (entry.orderId && entry.orderId !== ctx.orderId && !otherRefs.has(entry.orderId)) otherRefs.set(entry.orderId, (await getCase(entry.orderId))?.order.reference ?? "")
  // Store the card. Code writes the source chips, the deadline sentence and the severity.
  const now = await clockNow()
  const fresh = await getCase(ctx.orderId)
  const u = urgency(fresh ?? file, now)
  const severity = u.safety ? "safety" : u.timeRisk || (fresh ?? file).open.alerts.some((alert) => alert.severity === "high" || alert.severity === "critical") ? "high" : "normal"
  const otherRef = (entry: TimelineItem) => entry.orderId && entry.orderId !== ctx.orderId ? ctx.draft.affected.find((item) => item.orderId === entry.orderId)?.reference ?? (otherRefs.get(entry.orderId) ?? undefined) : undefined
  const findings: CardFinding[] = drafts.map((draft, index) => {
    const also = citedAlso[index]
    return {
      reference: otherRef(cited[index]),
      text: draft.text, source_entry_id: cited[index].id, source_label: cited[index].chip, at: cited[index].at,
      also: also ? { source_entry_id: also.id, source_label: also.chip, at: also.at } : null,
    }
  })
  const reasons = [...new Set(options[0].steps.map((step) => describe(step.action)).filter((entry) => entry && entry.level !== "auto").map((entry) => entry!.reason))]
  const cardOptions: CardOption[] = [
    ...options.map((option, index) => ({
      id: `opt-${index + 1}`, label: option.label, action: option.steps[0]?.action ?? "answer", params: option.steps[0]?.params ?? {},
      steps: option.steps, effect_text: option.effect, kind: kind === "question" ? "answer" as const : "approve" as const,
    })),
    { id: "reject", label: rejectLabel, action: "reject", params: {}, kind: "reject" as const },
  ]
  const cardId = `card_${randomUUID().slice(0, 12)}`
  const group = ctx.draft.affected.length > 1 ? ctx.draft.affected.map((item) => ({ order_id: item.orderId, reference: item.reference, car: item.car, effect: item.effect })) : null
  // Earned autonomy: a person made an action automatic (Settings, or the suggestion in For you). When every action of
  // the first option is automatic now, within its cost limit, and at least one of them needed approval by default,
  // the agent carries it out without a card. The order says so; the person can change the rule at any time.
  const stepCosts = options[0].steps.map((step) => {
    const cents = (step.params.lookup as { price_cents?: number | null } | undefined)?.price_cents
    return step.action === "approve_repair_cost" ? Number(step.params.amount_eur ?? 0) || null : step.action === "raise_fee" ? Number(step.params.amount_eur ?? 0) || null : cents ? cents / 100 : null
  })
  const byRule = kind === "decision" && !group && options[0].steps.some((step) => describe(step.action)?.level === "approval")
    && await levelForAll(options[0].steps.map((step) => step.action), stepCosts) === "auto"
  await db.update(cards).set({ status: "expired" }).where(and(eq(cards.orderId, ctx.orderId), eq(cards.status, "open"), ne(cards.id, cardId)))
  await db.insert(cards).values({
    id: cardId, orderId: ctx.orderId, runId: ctx.runId, createdAt: now, kind, status: byRule ? "approved" : "open",
    headline: group ? `${group.length} orders: ${headline}` : `${file.order.car.label}: ${headline}`, whatHappened, findings,
    proposal: {
      action: cardOptions[0].action, params: cardOptions[0].params, effect_text: options[0].effect,
      requires_approval_reason: reasons.length ? `it ${reasons.map((reason) => reason.replace(/^it /, "")).join(" and ")}` : null, cost_eur: costEur,
    },
    options: cardOptions, consequenceAt: u.at ? new Date(u.at) : null, consequenceText: u.sentence, severity,
    verifierNotes: verification.notes, origin: "agent", group,
  })
  if (byRule) return carryOutByRule(ctx, cardId, cardOptions[0], now)
  for (const orderId of group ? group.map((item) => item.order_id) : [ctx.orderId]) {
    await writeEntry({
      orderId, at: now, source: "agent", channel: "agent_card", authorType: "agent", authorLabel: AGENT_LABEL, kind: "proposal",
      summary: `${kind === "question" ? `Asked Ops: ${headline}` : `Proposed: ${options[0].label.replace(/^Approve:\s*/i, "")}. Waiting for a person`}${group ? ` (one card for ${group.map((item) => item.reference).join(", ")})` : ""}`,
      evidence: { table: "cards", id: cardId },
    })
  }
  ctx.draft = emptyDraft()
  return { content: "The card is in front of a person now. Your run ends here.", summary: `Proposed to a person: ${options[0].label}`, finish: { kind: "card", cardId, summary: headline }, output: { cardId, verifier: verification.notes } }
}

/** The person's rule allows this option: the Executor carries it out now, recorded as a decision by the agent under that rule. */
async function carryOutByRule(ctx: RunCtx, cardId: string, option: CardOption, now: Date): Promise<ToolOutcome> {
  const rules = await Promise.all((option.steps ?? []).map((step) => db.select().from(policies).where(eq(policies.action, step.action)).limit(1)))
  const rule = rules.flat().filter((row) => describe(row.action)?.level === "approval" && row.level === "auto")
    .map((row) => `${describe(row.action)?.label.toLowerCase()}${row.autoLimitEur ? ` up to €${row.autoLimitEur}` : ""}`).join(", ")
  const decisionId = `dec_${randomUUID()}`
  const actor = "Agent, under your rule"
  await db.insert(decisions).values({ id: decisionId, cardId, decidedAt: now, actor, choice: option.id, replyText: null, executedEffect: null, executeAfter: now, finalizedAt: now })
  const { execute } = await import("../executor")
  const effect = await execute({ decisionId, orderId: ctx.orderId, option, actor })
  await db.update(decisions).set({ executedEffect: effect }).where(eq(decisions.id, decisionId))
  const done = effect.steps.map((step) => step.summary).join("; ")
  if (!effect.ok) {
    // It did not work: a person sees the card after all, with what went wrong.
    const failed = effect.steps.find((step) => !step.ok)?.summary ?? "it was not carried out"
    await db.update(cards).set({ status: "open" }).where(eq(cards.id, cardId))
    await writeEntry({ orderId: ctx.orderId, at: now, source: "agent", channel: "agent_card", authorType: "agent", authorLabel: AGENT_LABEL, kind: "proposal", summary: `Tried to do this under your rule (${rule}), but ${failed.charAt(0).toLowerCase()}${failed.slice(1)}. Waiting for a person`, evidence: { table: "cards", id: cardId } })
    return { content: `Your proposal was allowed by the person's rule, but the Executor could not carry it out: ${failed}. The card is in front of a person now. Your run ends here.`, summary: `Rule allowed it, the Executor could not do it: ${failed}`, finish: { kind: "card", cardId, summary: failed } }
  }
  await writeEntry({
    id: `decision:${decisionId}`, orderId: ctx.orderId, at: now, source: "agent", channel: "agent_rule", authorType: "agent", authorLabel: AGENT_LABEL, kind: "decision", status: "done",
    summary: `Done without asking, under your rule (${rule}): ${done}`, evidence: { table: "decisions", id: decisionId },
  })
  ctx.draft = emptyDraft()
  return { content: `The person's rule allows this (${rule}), so it was carried out without a card: ${done}. Your run ends here.`, summary: `Carried out under the person's rule (${rule}): ${done}`, finish: { kind: "resolved", summary: `Did it without asking, under your rule (${rule}): ${done}`, nextCheckAt: null } }
}

export async function resolve(ctx: RunCtx, input: Input): Promise<ToolOutcome> {
  const summary = str(input.summary)
  const handles = Array.isArray(input.explained_by) ? input.explained_by.map(String) : []
  const problems = [...textProblems("The summary", summary)]
  if (!summary) problems.push("The summary is empty")
  if (summary.length > 220) problems.push(`The summary has ${summary.length} characters; write one plain sentence of at most 200`)
  const file = ctx.file ?? await getCase(ctx.orderId)
  if (file && isSafety(file)) problems.push("This is a safety case. An agent never closes a safety case on its own: propose a card so a person sees the outcome")
  const ids = handles.map((handle) => ctx.refs.resolve(handle))
  ids.forEach((id, index) => { if (!id) problems.push(`"${handles[index]}" is not an entry you were shown`) })
  if (!handles.length) problems.push("Cite at least one entry that explains why nothing needs a person")
  if (problems.length) return { content: `Not closed. Fix these and call resolve again:\n${problems.map((problem) => `- ${problem}`).join("\n")}`, summary: "Close sent back by code checks", isError: true, output: { problems } }
  const now = await clockNow()
  const minutes = typeof input.check_again_minutes === "number" ? input.check_again_minutes : null
  const nextCheckAt = minutes ? new Date(now.getTime() + minutes * 60_000) : null
  // The order no longer needs a person: the temporary alert card steps aside. Agent cards stay until decided.
  await db.update(cards).set({ status: "expired" }).where(and(eq(cards.orderId, ctx.orderId), eq(cards.status, "open"), eq(cards.origin, "alert")))
  const explaining = await entriesById(ids.filter((id): id is string => !!id))
  const zone = ctx.file ? orderView(ctx.file).zone : null
  await writeEntry({
    orderId: ctx.orderId, at: now, source: "agent", channel: "agent_resolve", authorType: "agent", authorLabel: AGENT_LABEL, kind: "event",
    summary: `Checked and closed without a card: ${summary}`,
    body: explaining.size ? `Explained by: ${[...explaining.values()].map((entry) => `${entry.authorLabel ?? entry.sourceLabel}, ${at(entry.at, zone)}: ${entry.summary}`).join(" · ")}` : null,
    evidence: { table: "agent_runs", id: ctx.runId },
  })
  return { content: "Closed. Your run ends here.", summary: `Closed without a card: ${summary}`, finish: { kind: "resolved", summary, nextCheckAt }, output: { explainedBy: ids } }
}
