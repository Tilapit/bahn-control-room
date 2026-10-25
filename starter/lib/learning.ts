// Learning without fine-tuning (round 4, item 4). Agents learn from past decisions three ways, all in code:
// the Investigator's find_similar_decisions tool (and the card's "Similar past cases"), playbook rules drafted
// when 3+ rejections share a reason for one action type (Haiku words them; a person approves only after the
// recorded evals pass; approved rules join the Investigator's prompt), and acceptance rates per action type,
// the same numbers the autonomy suggestion uses.

import { execFile } from "node:child_process"
import { and, desc, eq, inArray, isNotNull, ne, notInArray } from "drizzle-orm"
import { now as clockNow } from "./clock"
import { db } from "./db"
import { MODELS } from "./models"
import { primaryAction, REASON_WORDS, situationOf, verdictWords, OUTCOME_WORDS, isReason } from "./outcomes"
import { cards, customers, orders, pastDecisions, playbookRules, policies, relatedRecords } from "./schema"

export type SimilarCase = {
  id: string; reference: string | null; proposal: string; decision: string; verdict: string
  reasonText: string | null; outcome: string | null; outcomeNote: string | null; decidedAt: string; origin: string
}

type Features = { action: string; situation: string; country?: string | null; costEur?: number | null; excludeCardId?: string | null; excludeOrderId?: string | null }

/** Up to 3 past decisions on the same action type, the closest first: same situation, same market, a similar cost. */
export async function findSimilar(features: Features, limit = 3): Promise<SimilarCase[]> {
  const rows = await db.select({ row: pastDecisions, reference: orders.reference }).from(pastDecisions).leftJoin(orders, eq(orders.id, pastDecisions.orderId))
    .where(eq(pastDecisions.action, features.action))
  const score = (row: typeof pastDecisions.$inferSelect) => (row.situation === features.situation ? 4 : 0)
    + (features.country && row.country === features.country ? 1 : 0)
    + (features.costEur && row.costEur && Math.abs(row.costEur - features.costEur) <= features.costEur * 0.3 ? 1 : 0)
    + (row.outcome ? 0.5 : 0)
  return rows
    .filter(({ row }) => row.cardId !== features.excludeCardId && (!features.excludeOrderId || row.orderId !== features.excludeOrderId))
    .sort((a, b) => score(b.row) - score(a.row) || b.row.decidedAt.getTime() - a.row.decidedAt.getTime())
    .slice(0, limit)
    .map(({ row, reference }) => ({
      id: row.id, reference, proposal: row.proposal, decision: row.decision, verdict: verdictWords(row),
      reasonText: row.reasonText, outcome: row.outcome, outcomeNote: row.outcomeNote, decidedAt: row.decidedAt.toISOString(), origin: row.origin,
    }))
}

/** The card's own features: its proposal's action type, what it is about, the customer's country and the cost. */
export async function similarCases(cardId: string): Promise<SimilarCase[]> {
  const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1)
  if (!card) return []
  const action = primaryAction(card.options)
  if (!action) return []
  const [customer] = await db.select({ country: customers.country }).from(orders).innerJoin(customers, eq(customers.id, orders.customerId)).where(eq(orders.id, card.orderId)).limit(1)
  return findSimilar({ action, situation: situationOf(`${card.headline} ${card.whatHappened}`), country: customer?.country, costEur: card.proposal?.cost_eur ?? null, excludeCardId: card.id, excludeOrderId: card.orderId })
}

/** One line per case for the Investigator: "CD-420194 · 16 Oct · changed: wrong facts (“…”) · outcome: Worked". */
export function similarText(cases: SimilarCase[]): string {
  if (!cases.length) return "No past decisions on this kind of action yet."
  return cases.map((item) => `${item.reference ?? "an order"} · ${item.decidedAt.slice(0, 10)} · proposed: ${item.proposal} · ${item.verdict}${item.reasonText ? ` (“${item.reasonText}”)` : ""} · outcome: ${item.outcome ? `${OUTCOME_WORDS[item.outcome]}${item.outcomeNote ? `, ${item.outcomeNote}` : ""}` : "not checked"}${item.origin === "seeded" ? " · demo history" : ""} [past_decisions:${item.id}]`).join("\n")
}

// ---- acceptance -----------------------------------------------------------------------------------------------

export type Acceptance = { action: string; approvedUnchanged: number; decided: number; rate: number | null; earlier: { approved: number; changed: number; rejected: number } }

/** Approved unchanged out of decided, or null before the first decision. The autonomy suggestion uses this too. */
export const rateOf = (approvedUnchanged: number, decided: number): number | null => decided ? approvedUnchanged / decided : null

/**
 * Per action type: this control room's decisions (the policy counters, the numbers the autonomy suggestion rests on)
 * and the earlier ones kept in past_decisions (the dataset's reviews and the demo history).
 */
export async function acceptanceRates(): Promise<Acceptance[]> {
  const [policyRows, past] = await Promise.all([db.select().from(policies), db.select().from(pastDecisions).where(ne(pastDecisions.origin, "live"))])
  const byAction = new Map<string, Acceptance>()
  const get = (action: string) => byAction.get(action) ?? byAction.set(action, { action, approvedUnchanged: 0, decided: 0, rate: null, earlier: { approved: 0, changed: 0, rejected: 0 } }).get(action)!
  for (const row of policyRows) if (row.decidedCount) Object.assign(get(row.action), { approvedUnchanged: row.approvedUnchangedCount, decided: row.decidedCount, rate: rateOf(row.approvedUnchangedCount, row.decidedCount) })
  for (const row of past) get(row.action).earlier[row.decision as "approved" | "changed" | "rejected"] += 1
  return [...byAction.values()].sort((a, b) => b.decided + b.earlier.approved + b.earlier.changed + b.earlier.rejected - (a.decided + a.earlier.approved + a.earlier.changed + a.earlier.rejected))
}

// ---- playbook rules -------------------------------------------------------------------------------------------

/** How many rejections or changes with one reason, for one action type, before code drafts a rule. */
export const PLAYBOOK_THRESHOLD = 3

/** The rule in code's own words, when no model can write it (no API key) or the model fails. */
function fallbackWording(action: string, reason: string, notes: string[]): string {
  const what = ACTION_WORDS[action] ?? action.replace(/_/g, " ")
  const why = isReason(reason) ? REASON_WORDS[reason].toLowerCase() : reason
  return `Before proposing to ${what}, check what made people reject it before (${why}): ${notes.slice(0, 2).join("; ")}.`
}

export const ACTION_WORDS: Record<string, string> = {
  book_ferry: "book a ferry", change_ferry_booking: "move a ferry booking", book_hotel: "book a hotel", book_driver_travel: "book driver travel",
  cancel_driver_travel: "cancel driver travel", switch_driver: "give the gig to another driver", republish_offer: "offer the gig again", raise_fee: "raise the driver fee",
  change_pickup_time: "change the pickup time", change_delivery_time: "change the delivery time", book_tow: "book a tow", approve_repair_cost: "agree a repair cost",
  message_customer: "email the customer", call_customer: "call the customer", call_contact: "call a seller or other contact", message_driver: "message the driver",
  mark_handled: "close an alert as handled", look_up: "look something up", note: "record a note",
}

async function wordRule(action: string, reason: string, notes: string[]): Promise<{ text: string; by: string }> {
  const { hasApiKey, callText } = await import("./agents/llm")
  if (!hasApiKey()) return { text: fallbackWording(action, reason, notes), by: "code" }
  try {
    const result = await callText({
      model: MODELS.haiku, maxTokens: 300,
      system: "You write one playbook rule for an AI agent in a car delivery operations team. One sentence, at most 35 words, an instruction the agent can follow before it proposes this kind of action. Plain ops words (order, car, driver, ferry, customer). No ids, no names of people. Answer with the sentence only.",
      user: `Action the agent proposed: ${ACTION_WORDS[action] ?? action}\nWhy people rejected or changed it (${notes.length} times): ${isReason(reason) ? REASON_WORDS[reason] : reason}\nTheir words:\n${notes.map((note) => `- ${note}`).join("\n")}`,
    })
    const text = result.value.replace(/^["“]|["”]$/g, "").trim()
    return text ? { text, by: "Haiku" } : { text: fallbackWording(action, reason, notes), by: "code" }
  } catch {
    return { text: fallbackWording(action, reason, notes), by: "code" }
  }
}

/** Draft a suggestion for every action type and reason with 3+ rejections or changes that has no rule yet. */
export async function refreshPlaybookSuggestions(): Promise<number> {
  const rows = await db.select().from(pastDecisions).where(and(inArray(pastDecisions.decision, ["changed", "rejected"]), isNotNull(pastDecisions.reason)))
  const groups = new Map<string, typeof rows>()
  for (const row of rows) groups.set(`${row.action}:${row.reason}`, [...(groups.get(`${row.action}:${row.reason}`) ?? []), row])
  const existing = new Set((await db.select({ id: playbookRules.id }).from(playbookRules)).map((row) => row.id))
  let drafted = 0
  for (const [id, group] of groups) {
    if (group.length < PLAYBOOK_THRESHOLD || existing.has(id)) continue
    const notes = [...new Set(group.map((row) => row.reasonText).filter((note): note is string => !!note))]
    const words = await wordRule(group[0].action, group[0].reason!, notes)
    await db.insert(playbookRules).values({ id, action: group[0].action, reason: group[0].reason!, basedOn: group.map((row) => row.id), text: words.text, wordedBy: words.by, status: "suggested", createdAt: await clockNow() }).onConflictDoNothing()
    drafted += 1
  }
  return drafted
}

/** Run the recorded evals (no model, no database writes): the rule is approved only when every group passes. */
function runRecordedEvals(): Promise<{ passed: boolean; summary: string }> {
  return new Promise((resolve) => {
    execFile("npx", ["tsx", "scripts/evals.ts", "--recorded"], { cwd: process.cwd(), timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`
      const line = out.split("\n").map((part) => part.trim()).filter(Boolean).reverse().find((part) => /groups? (passed|failed)|passed|failed/i.test(part))
      resolve({ passed: !error && /All \d+ groups passed/.test(out), summary: line ?? (error ? error.message : "No result") })
    })
  })
}

export async function approveRule(id: string): Promise<{ passed: boolean; summary: string }> {
  const [rule] = await db.select().from(playbookRules).where(eq(playbookRules.id, id)).limit(1)
  if (!rule || rule.status !== "suggested") throw new Error("This rule is no longer waiting for a decision.")
  const result = await runRecordedEvals()
  await db.update(playbookRules).set({
    evalPassed: result.passed, evalResult: result.summary,
    ...(result.passed ? { status: "approved", decidedAt: await clockNow() } : {}),
  }).where(eq(playbookRules.id, id))
  return result
}

export async function dismissRule(id: string): Promise<void> {
  await db.update(playbookRules).set({ status: "dismissed", decidedAt: await clockNow() }).where(and(eq(playbookRules.id, id), eq(playbookRules.status, "suggested")))
}

export async function playbook() {
  return db.select().from(playbookRules).orderBy(desc(playbookRules.createdAt))
}

/** The approved rules, as a block for the Investigator's system prompt (null when there are none). */
export async function playbookPrompt(): Promise<string | null> {
  const rules = await db.select().from(playbookRules).where(eq(playbookRules.status, "approved")).orderBy(playbookRules.id)
  if (!rules.length) return null
  return `Playbook rules approved by Ops from past decisions. Follow them when they apply:\n${rules.map((rule) => `- ${rule.text}`).join("\n")}`
}

// ---- Settings → Learning ---------------------------------------------------------------------------------------

export type PastRow = typeof pastDecisions.$inferSelect & { reference: string | null }

/** Everything the Learning page shows: acceptance per action type, reasons, outcomes and the playbook. */
export async function learningSummary() {
  const [rates, rows, rules] = await Promise.all([
    acceptanceRates(),
    db.select({ row: pastDecisions, reference: orders.reference }).from(pastDecisions).leftJoin(orders, eq(orders.id, pastDecisions.orderId)).orderBy(desc(pastDecisions.decidedAt)),
    playbook(),
  ])
  const past: PastRow[] = rows.map(({ row, reference }) => ({ ...row, reference }))
  const reasons = new Map<string, number>()
  for (const row of past) if (row.reason && row.decision !== "approved") reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1)
  const outcomes = { worked: 0, partly: 0, didnt_work: 0, unchecked: 0 }
  for (const row of past) {
    if (row.outcome === "worked" || row.outcome === "partly" || row.outcome === "didnt_work") outcomes[row.outcome] += 1
    else outcomes.unchecked += 1
  }
  return { rates, past, reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]), outcomes, rules }
}

// ---- demo history ---------------------------------------------------------------------------------------------

/**
 * Made-up history for the demo, marked origin "seeded" and shown as demo history: three earlier rejections of a
 * ferry booking with the same reason, on delivered orders, so one playbook suggestion is visible. The reason is the
 * one the dataset's own reviewers gave on CD-420194 ("Do not select a crossing from an unrefreshed list").
 */
export async function seedDemoHistory(): Promise<number> {
  const delivered = await db.select({ id: orders.id, country: customers.country }).from(orders).innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.status, "DELIVERED"), notInArray(orders.id, db.select({ id: relatedRecords.orderId }).from(relatedRecords).where(and(eq(relatedRecords.collection, "agent_proposals"), isNotNull(relatedRecords.orderId))))))
    .orderBy(orders.reference).limit(6)
  const real = delivered.filter((row) => !row.id.includes("-s")).slice(0, 3)
  const notes = [
    "The quote was from the morning; the ferry line was not asked again before booking.",
    "Space on that sailing was not re-checked; the list was hours old.",
    "Ask the ferry line for current space first, then come back with the booking.",
  ]
  const values = real.map((row, index) => ({
    id: `seeded:book_ferry:${index + 1}`, origin: "seeded", orderId: row.id, cardId: null, action: "book_ferry", situation: "ferry",
    proposal: "Book the next sailing from the earlier quote", costEur: [412, 365, 438][index], country: row.country,
    decidedAt: new Date(Date.parse("2026-10-16T08:30:00Z") + index * 26 * 3600_000), actor: "Ops (demo history)", decision: "rejected",
    reason: "wrong_facts", reasonText: notes[index], label: "negative", dueAt: null, outcome: null,
    outcomeNote: "Rejected: nothing was carried out, so there is nothing to check", outcomeSource: null, outcomeCheckedAt: null,
  }))
  await db.delete(pastDecisions).where(eq(pastDecisions.origin, "seeded"))
  if (values.length) await db.insert(pastDecisions).values(values)
  return values.length
}
