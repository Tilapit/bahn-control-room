// propose and resolve: how an Investigator run ends. propose builds a card only
// after code has checked every source and every action against the policy table,
// and the Verifier has checked each claim against the record it cites. Severity,
// the deadline sentence and the source chips are written by code, not the model.

import { randomUUID } from "node:crypto"
import { and, eq, ne } from "drizzle-orm"
import { entriesById, getCase, type TimelineItem } from "../case"
import { now as clockNow } from "../clock"
import { db } from "../db"
import { MODELS } from "../models"
import { describe, levelForAll, PROPOSABLE } from "../policies"
import { orderView } from "../queue"
import { cards } from "../schema"
import type { CardFinding, CardOption, CardStep } from "../schema"
import { at } from "../time"
import { isSafety, urgency } from "../urgency"
import { writeEntry } from "./entries"
import { findingProblems, textProblems } from "./lint"
import { AGENT_LABEL, type RunCtx, type ToolOutcome } from "./tools"
import { verifyCard } from "./verifier"

type Input = Record<string, unknown>
type DraftOption = { label: string; effect: string; steps: CardStep[] }

const COST_LIMIT_EUR = 500
/** How many times the Verifier may send a card back before its notes go on the card as they are. */
const VERIFIER_ROUNDS = 2
/** Params that must name something a look-up in this run returned. */
const NEEDS_LOOKUP = new Set(["book_ferry", "change_ferry_booking", "book_hotel", "book_driver_travel", "switch_driver", "book_tow", "approve_repair_cost"])

const str = (value: unknown) => typeof value === "string" ? value.trim() : ""
/** An array of objects. Models sometimes send a nested array as a JSON string; accept that too. */
const list = (value: unknown): Input[] => {
  let parsed = value
  if (typeof value === "string") { try { parsed = JSON.parse(value) } catch { return [] } }
  return Array.isArray(parsed) ? parsed.filter((item): item is Input => typeof item === "object" && item !== null) : []
}

function readOptions(input: Input): DraftOption[] {
  return list(input.options).map((option) => ({
    label: str(option.label), effect: str(option.effect),
    steps: list(option.steps).map((step) => ({ action: str(step.action), params: typeof step.params === "object" && step.params ? step.params as Record<string, unknown> : {} })),
  }))
}

function rejectBack(problems: string[], summary: string): ToolOutcome {
  return {
    content: `The card was not shown to anyone. Fix these and call propose again:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    summary, isError: true, output: { problems },
  }
}

export async function propose(ctx: RunCtx, input: Input): Promise<ToolOutcome> {
  const kind = input.kind === "question" ? "question" : "decision"
  const file = ctx.file ?? await getCase(ctx.orderId)
  if (!file) return rejectBack(["The order could not be loaded."], "Could not load the order")
  const carPrefix = new RegExp(`^${file.order.car.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[:,\\s-]*`, "i")
  const headline = str(input.headline).replace(carPrefix, "")
  const whatHappened = str(input.what_happened)
  const rejectLabel = str(input.reject_label) || "Reject"
  const options = readOptions(input)
  const drafts = list(input.findings).map((finding) => ({ text: str(finding.text), source: str(finding.source), also: str(finding.also) || null }))
  const problems: string[] = []

  // A malformed call (lists sent as text, or empty) gets one clear instruction rather than a list of symptoms.
  if ((typeof input.findings === "string" && !drafts.length) || (typeof input.options === "string" && !options.length) || (!drafts.length && !options.length)) {
    return rejectBack(["Your propose call arrived malformed: findings and options must be JSON lists of objects, and neither may be empty. Send the whole card again in one call."], "Card call arrived malformed; sent back")
  }

  // Shape.
  if (!headline) problems.push("The headline is empty")
  if (headline.length > 80) problems.push(`The headline has ${headline.length} characters; keep it under 70`)
  if (!whatHappened) problems.push("what_happened is empty")
  if (drafts.length < 2 || drafts.length > 7) problems.push(`Give three to seven findings (you gave ${drafts.length})`)
  if (whatHappened.length > 420) problems.push(`what_happened has ${whatHappened.length} characters; keep it to one or two sentences (under 350); the findings carry the detail`)
  if (!options.length) problems.push("Give at least one option")
  if (options.length > 3) problems.push("Give at most three options")
  problems.push(...textProblems("The headline", headline), ...textProblems("what_happened", whatHappened), ...textProblems("The reject label", rejectLabel))

  // Every finding cites an entry this run was shown.
  const entryIds = drafts.map((draft) => ctx.refs.resolve(draft.source))
  const alsoIds = drafts.map((draft) => draft.also ? ctx.refs.resolve(draft.also) : null)
  const entries = await entriesById([...entryIds, ...alsoIds].filter((id): id is string => !!id))
  const cited: (TimelineItem | null)[] = entryIds.map((id) => id ? entries.get(id) ?? null : null)
  const citedAlso: (TimelineItem | null)[] = alsoIds.map((id) => id ? entries.get(id) ?? null : null)
  drafts.forEach((draft, index) => {
    problems.push(...findingProblems(index, draft, cited[index]))
    if (draft.also && !citedAlso[index]) problems.push(`Finding ${index + 1} cites "${draft.also}" as its second source, which is not an entry you were shown`)
  })

  // Every action is known, allowed, and names something a look-up returned.
  let computedCostCents = 0
  options.forEach((option, index) => {
    const label = `Option ${index + 1}`
    if (!option.label) problems.push(`${label} has no label`)
    if (option.label.length > 80) problems.push(`${label}'s label is too long; keep it under 70 characters`)
    problems.push(...textProblems(`${label}'s label`, option.label), ...textProblems(`${label}'s effect`, option.effect))
    if (kind === "decision" && !option.steps.length) problems.push(`${label} has no steps; a decision option must do something (use note to keep the plan)`)
    for (const step of option.steps) {
      if (!PROPOSABLE.includes(step.action)) { problems.push(`${label} uses "${step.action}", which is not an action you can propose`); continue }
      if (NEEDS_LOOKUP.has(step.action)) {
        const lookup = ctx.lookups[str(step.params.id)]
        if (!lookup) problems.push(`${label}: ${step.action} needs an id returned by a look-up in this run ("${str(step.params.id)}" was not)`)
        else {
          step.params = { ...step.params, lookup: { kind: lookup.kind, label: lookup.label, price_cents: lookup.priceCents, details: lookup.details } }
          if (index === 0 && lookup.priceCents && step.action !== "switch_driver") computedCostCents += lookup.priceCents
        }
      }
      if (step.action === "approve_repair_cost" && index === 0) computedCostCents += Math.round(Number(step.params.amount_eur ?? 0) * 100)
    }
  })
  // A car with a booked crossing gets that booking moved, never a second one beside it.
  const hasBookedFerry = file.plan.bookings.some((booking) => booking.kind === "Ferry" && booking.state === "booked")
  options.forEach((option, index) => {
    if (hasBookedFerry && option.steps.some((step) => step.action === "book_ferry")) problems.push(`Option ${index + 1} books a ferry, but this car already has a booked crossing; use change_ferry_booking to move it, or the car would hold two crossings`)
  })
  const levels = await Promise.all(options.map((option) => levelForAll(option.steps.map((step) => step.action))))
  levels.forEach((level, index) => { if (level === "never") problems.push(`Option ${index + 1} contains an action that is never allowed`) })
  if (problems.length) return rejectBack(problems, `Card sent back by code checks (${problems.length} problem${problems.length === 1 ? "" : "s"})`)

  // Over €500: the senior model decides (SPEC 7), whatever the agent wrote as the cost.
  const costEur = Math.max(typeof input.cost_eur === "number" ? input.cost_eur : 0, computedCostCents / 100) || null
  if (costEur && costEur > COST_LIMIT_EUR && ctx.model !== MODELS.opus) {
    return {
      content: `This proposal costs about €${Math.round(costEur)}, over the €${COST_LIMIT_EUR} limit for your model. The case is now with the senior model, with everything done so far. Review it and call propose again.`,
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
      findings: drafts.map((draft, index) => ({ text: draft.text, entry: cited[index]!, also: citedAlso[index] })),
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
    return {
      content: `The verifier found that two records disagree: ${verification.conflict} Conflicting evidence is handled by the senior model, so the case is now with it, with everything done so far. Review the evidence. If a question to the driver or the site would settle the disagreement, ask it before you propose. On the card, put both statements with their times and the gap between them.`,
      summary: "Verifier found conflicting sources; handed to the senior model", switchModel: { model: MODELS.opus, reason: `Conflicting evidence: ${verification.conflict}` },
    }
  }
  const failing = verification.notes.filter((note) => !note.ok)
  if (verification.verdict === "fix" && failing.length && ctx.verifierRounds <= VERIFIER_ROUNDS) {
    return {
      content: `The verifier checked each claim against its source and found problems. The card was not shown yet. Fix these and call propose again:\n${failing.map((note) => `- ${note.finding != null ? `Finding ${note.finding + 1}: ` : ""}${note.note}`).join("\n")}`,
      summary: `Card sent back by the verifier (${failing.length} problem${failing.length === 1 ? "" : "s"})`, isError: true, output: verification.notes,
    }
  }

  // Store the card. Code writes the source chips, the deadline sentence and the severity.
  const now = await clockNow()
  const fresh = await getCase(ctx.orderId)
  const u = urgency(fresh ?? file, now)
  const severity = u.safety ? "safety" : u.timeRisk || (fresh ?? file).open.alerts.some((alert) => alert.severity === "high" || alert.severity === "critical") ? "high" : "normal"
  const findings: CardFinding[] = drafts.map((draft, index) => {
    const also = citedAlso[index]
    return {
      text: draft.text, source_entry_id: cited[index]!.id, source_label: cited[index]!.chip, at: cited[index]!.at,
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
  await db.update(cards).set({ status: "expired" }).where(and(eq(cards.orderId, ctx.orderId), eq(cards.status, "open"), ne(cards.id, cardId)))
  await db.insert(cards).values({
    id: cardId, orderId: ctx.orderId, runId: ctx.runId, createdAt: now, kind, status: "open",
    headline: `${file.order.car.label}: ${headline}`, whatHappened, findings,
    proposal: {
      action: cardOptions[0].action, params: cardOptions[0].params, effect_text: options[0].effect,
      requires_approval_reason: reasons.length ? `it ${reasons.map((reason) => reason.replace(/^it /, "")).join(" and ")}` : null, cost_eur: costEur,
    },
    options: cardOptions, consequenceAt: u.at ? new Date(u.at) : null, consequenceText: u.sentence, severity,
    verifierNotes: verification.notes, origin: "agent",
  })
  await writeEntry({
    orderId: ctx.orderId, at: now, source: "agent", channel: "agent_card", authorType: "agent", authorLabel: AGENT_LABEL, kind: "proposal",
    summary: kind === "question" ? `Asked Ops: ${headline}` : `Proposed: ${options[0].label.replace(/^Approve:\s*/i, "")}. Waiting for a person`,
    evidence: { table: "cards", id: cardId },
  })
  return { content: "The card is in front of a person now. Your run ends here.", summary: `Proposed to a person: ${options[0].label}`, finish: { kind: "card", cardId, summary: headline }, output: { cardId, verifier: verification.notes } }
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
  if (problems.length) return rejectBack(problems, "Close sent back by code checks")
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
