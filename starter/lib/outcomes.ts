// Decision feedback (round 4, item 3). A person who rejects or changes a proposal gives one reason; approving it
// unchanged is a positive label. Every decision carried out here is kept in past_decisions, and after its
// deadline on the simulated clock code checks, from the records, whether it worked. The dataset's own reviewed
// agent proposals are kept the same way (origin dataset), with outcomes from their execution records.

import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm"
import { now as clockNow, SNAPSHOT_AT } from "./clock"
import { db } from "./db"
import { cards, customers, decisions, orders, pastDecisions, relatedRecords, timelineEntries } from "./schema"
import type { CardOption } from "./schema"
import { isReason, type Reason } from "./reasons"

export { REASONS, REASON_WORDS, OUTCOME_WORDS, feedbackError, feedbackRule, isReason, verdictWords, type Feedback, type Reason } from "./reasons"

/** The action a card's proposal is about: its first option's first step, in the policies' words. */
export function primaryAction(options: CardOption[]): string | null {
  const primary = options.find((option) => option.kind !== "reject" && option.action !== "reject") ?? null
  return primary ? (primary.steps?.[0]?.action ?? primary.action) : null
}

const SITUATIONS: [RegExp, string][] = [
  [/warning light|breakdown|stopped|parked vehicle|mechanical|safe stop|tow|repair/i, "car_problem"],
  [/backup|ill\b|sick|cancel(l)?ed the gig|no driver|switch driver/i, "driver"],
  [/sold out|no space|ferry.*full/i, "ferry_sold_out"],
  [/check-in|ferry|crossing|sailing/i, "ferry"],
  [/not found|empty pickup|not collected|pickup/i, "pickup"],
  [/strike|protest|closure|disruption/i, "disruption"],
  [/not moving|no gps|no position|tracking gap|silent/i, "no_position"],
  [/invoice|billing|payment/i, "billing"],
  [/damage|condition|scratch|photo|mark\b/i, "condition"],
  [/train|flight|positioning/i, "driver_travel"],
  [/deliver|promise/i, "delivery"],
]

/** What a card or a proposal was about, by code from its words: the "situation" a similar case must share. */
export function situationOf(text: string): string {
  return SITUATIONS.find(([pattern]) => pattern.test(text))?.[1] ?? "other"
}

/** Keep a decision that was carried out (after its undo window) for learning. Undone decisions never get here. */
export async function recordPastDecision(decisionId: string): Promise<void> {
  const [row] = await db.select({ decision: decisions, card: cards }).from(decisions).innerJoin(cards, eq(cards.id, decisions.cardId)).where(eq(decisions.id, decisionId)).limit(1)
  if (!row) return
  const { decision, card } = row
  const action = primaryAction(card.options)
  if (!action || !decision.label) return
  const chosen = card.options.find((option) => option.id === decision.choice)
  const primary = card.options.find((option) => option.kind !== "reject" && option.action !== "reject")
  const verdict = decision.label === "positive" ? "approved" : chosen && chosen.kind !== "reject" && chosen.action !== "reject" && decision.choice !== "reply" ? "changed" : decision.choice === "reply" ? "changed" : "rejected"
  const [customer] = await db.select({ country: customers.country }).from(orders).innerJoin(customers, eq(customers.id, orders.customerId)).where(eq(orders.id, card.orderId)).limit(1)
  const dueAt = card.consequenceAt ?? new Date(decision.decidedAt.getTime() + 2 * 3600_000)
  await db.insert(pastDecisions).values({
    id: decision.id, origin: "live", orderId: card.orderId, cardId: card.id, action,
    situation: situationOf(`${card.headline} ${card.whatHappened}`),
    proposal: (primary?.label ?? card.headline).replace(/^approve:\s*/i, ""),
    costEur: card.proposal?.cost_eur ?? null, country: customer?.country ?? null,
    decidedAt: decision.decidedAt, actor: decision.actor, decision: verdict,
    reason: decision.reason, reasonText: decision.reasonText, label: decision.label, dueAt,
  }).onConflictDoNothing()
}

type Source = { label: string; at: string; table: string; id: string }

/** An alert about the same kind of problem, raised on the order after a moment: the problem came back. */
async function alertAfter(orderId: string, after: Date, until: Date, situation: string | null): Promise<Source & { summary: string } | null> {
  const entries = await db.select().from(timelineEntries)
    .where(and(eq(timelineEntries.orderId, orderId), eq(timelineEntries.kind, "alert"), gt(timelineEntries.occurredAt, after), lte(timelineEntries.occurredAt, until)))
    .orderBy(timelineEntries.occurredAt)
  // An invoice question after a ferry rebooking says nothing about the ferry.
  const entry = entries.find((candidate) => !situation || situation === "other" || situationOf(candidate.summary) === situation)
  return entry ? { label: entry.authorLabel ?? "Alert", at: entry.occurredAt.toISOString(), table: "timeline_entries", id: entry.id, summary: entry.summary } : null
}

/**
 * Check every live decision whose deadline has passed on the simulated clock. From the records: the Executor failed
 * → Didn't work; a new alert on the order after the decision → Partly; otherwise → Worked, resting on the last thing
 * the decision wrote. Idempotent: a checked decision is never checked again.
 */
export async function checkOutcomes(at?: Date): Promise<number> {
  const now = at ?? await clockNow()
  const due = await db.select().from(pastDecisions).where(and(eq(pastDecisions.origin, "live"), isNull(pastDecisions.outcomeCheckedAt), lte(pastDecisions.dueAt, now)))
  for (const row of due) {
    const [decision] = await db.select().from(decisions).where(eq(decisions.id, row.id)).limit(1)
    const effect = decision?.executedEffect ?? null
    const written = await db.select().from(timelineEntries).where(sql`${timelineEntries.evidence}->>'table' = 'decisions' and ${timelineEntries.evidence}->>'id' = ${row.id}`).orderBy(timelineEntries.occurredAt)
    const last = written[written.length - 1]
    const own: Source | null = last ? { label: last.authorLabel ?? "Control room", at: last.occurredAt.toISOString(), table: "timeline_entries", id: last.id } : null
    let outcome: string, note: string, source: Source | null
    const alert = row.orderId ? await alertAfter(row.orderId, row.decidedAt, now, row.situation) : null
    if (row.decision === "approved" && effect && !effect.ok) {
      const failed = effect.steps.find((step) => !step.ok)
      outcome = "didnt_work"; note = `Not carried out: ${failed?.summary ?? "a step failed"}`; source = own
    } else if (alert) {
      outcome = "partly"; note = `A new alert after the decision: ${alert.summary}`; source = alert
    } else {
      outcome = "worked"; note = row.decision === "approved" ? "Carried out, and no new alert on the order by the deadline" : "No new alert on the order by the deadline"; source = own
    }
    await db.update(pastDecisions).set({ outcome, outcomeNote: note, outcomeSource: source, outcomeCheckedAt: now }).where(eq(pastDecisions.id, row.id))
  }
  return due.length
}

// ---- the dataset's reviewed proposals -------------------------------------------------------------------------

/** The dataset's commands in the policies' words, so a past review counts for the same kind of card. */
export const COMMAND_ACTION: Record<string, string> = {
  "travel.book_ferry": "book_ferry",
  "travel.rebook": "change_ferry_booking",
  "travel.book_driver_positioning": "book_driver_travel",
  "assignment.prepare_backup": "switch_driver",
  "driver.request_safe_stop_details": "message_driver",
  "alert.resolve": "mark_handled",
  "travel.refresh_crossing": "look_up",
  "travel.refresh_quote": "look_up",
  "billing.check_reference": "look_up",
  "condition.record_attribution": "note",
}

/** The reviewers' notes in the dataset, each mapped by hand to one of the five reasons (their words are kept too). */
const NOTE_REASON: [RegExp, Reason][] = [
  [/connectivity gap|boarding unconfirmed/i, "wrong_facts"],
  [/restart advice|owner recovery decision/i, "customer_must_decide"],
  [/unrefreshed list|verified replacement/i, "wrong_facts"],
  [/photos establish/i, "wrong_facts"],
]

type Proposal = {
  id: string; command?: string; summary?: string; status?: string; created_at?: string
  review?: { decision?: string; reviewed_at?: string; reviewer_id?: string; decision_note?: string; final_payload?: unknown } | null
  execution?: { status?: string; attempted_at?: string; error?: string | null } | null
  proposed_payload?: unknown
}

/**
 * Rebuild the dataset's past decisions from its reviewed agent proposals (not scale mode's copies). Each one's outcome
 * is checked against the snapshot: failed → Didn't work; carried out and a new alert after it → Partly; carried out
 * and nothing after it → Worked; approved but not carried out yet, or rejected → no outcome (nothing to check).
 */
export async function seedDatasetDecisions(): Promise<{ rows: number; withOutcome: number }> {
  const rows = await db.select({ id: relatedRecords.id, orderId: relatedRecords.orderId, details: relatedRecords.details, country: customers.country })
    .from(relatedRecords).innerJoin(orders, eq(orders.id, relatedRecords.orderId)).innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(relatedRecords.collection, "agent_proposals"), sql`not (${orders.details} ? 'synthetic_of')`))
  // The dataset is a snapshot: its outcomes are checked against what the records show at the snapshot.
  const now = SNAPSHOT_AT
  const values: (typeof pastDecisions.$inferInsert)[] = []
  for (const row of rows) {
    const d = row.details as Proposal
    const review = d.review
    if (!review?.decision || !review.reviewed_at || !d.command) continue
    const decidedAt = new Date(review.reviewed_at)
    const decision = review.decision === "REJECTED" ? "rejected" : review.decision === "EDITED" ? "changed" : "approved"
    const note = review.decision_note ?? null
    const reason = decision === "approved" ? null : NOTE_REASON.find(([pattern]) => note && pattern.test(note))?.[1] ?? "other"
    const attempted = d.execution?.attempted_at ? new Date(d.execution.attempted_at) : null
    // What the proposal was about, from its own summary first; the reviewer's note only when the summary says nothing.
    const situation = situationOf(d.summary ?? "") !== "other" ? situationOf(d.summary ?? "") : situationOf(note ?? "")
    let outcome: string | null = null, outcomeNote: string, source: Source | null = null
    const entry = (suffix: string, at: Date, label: string): Source => ({ label, at: at.toISOString(), table: "timeline_entries", id: `agent_proposals:${row.id}${suffix}` })
    if (d.execution?.status === "FAILED" && attempted) {
      outcome = "didnt_work"; outcomeNote = `The attempt failed${d.execution.error ? `: ${d.execution.error}` : ""}`; source = entry(":execution", attempted, "Agent (attempt)")
    } else if (d.execution?.status === "SUCCEEDED" && attempted) {
      const alert = row.orderId ? await alertAfter(row.orderId, attempted, now, situation) : null
      if (alert) { outcome = "partly"; outcomeNote = `Carried out; a new alert after it: ${alert.summary}`; source = alert }
      else { outcome = "worked"; outcomeNote = "Carried out, and no new alert on the order up to the snapshot"; source = entry(":execution", attempted, "Agent (carried out)") }
    } else {
      outcomeNote = decision === "rejected" ? "Rejected: nothing was carried out, so there is nothing to check" : "Approved, not carried out by the snapshot: nothing to check yet"
    }
    values.push({
      id: `dataset:${row.id}`, origin: "dataset", orderId: row.orderId, cardId: null, action: COMMAND_ACTION[d.command] ?? d.command,
      situation, proposal: String(d.summary ?? d.command).replace(/\.$/, ""),
      costEur: null, country: row.country, decidedAt, actor: review.reviewer_id ?? "Ops", decision, reason, reasonText: note,
      label: decision === "approved" ? "positive" : "negative", dueAt: attempted ?? decidedAt,
      outcome, outcomeNote, outcomeSource: source, outcomeCheckedAt: outcome ? now : null,
    })
  }
  await db.transaction(async (tx) => {
    await tx.delete(pastDecisions).where(eq(pastDecisions.origin, "dataset"))
    if (values.length) await tx.insert(pastDecisions).values(values)
  })
  return { rows: values.length, withOutcome: values.filter((value) => value.outcome).length }
}

/** Forget the live past decisions of these cards (demo and test resets). */
export async function forgetPastDecisions(cardIds: string[] | "all"): Promise<void> {
  if (cardIds === "all") await db.delete(pastDecisions).where(eq(pastDecisions.origin, "live"))
  else if (cardIds.length) await db.delete(pastDecisions).where(inArray(pastDecisions.cardId, cardIds))
}
