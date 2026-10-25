// Test and demo helper: forget everything agents, people and the demo did live on
// one order (runs, steps, agent cards, decisions, live timeline entries, demo
// events) and reopen its temporary alert card. The dataset itself is untouched.

import { and, eq, inArray, sql } from "drizzle-orm"
import { db } from "../db"
import { agentRuns, agentSteps, cards, decisions, demoEvents, evalCases, facts, pastDecisions, policies, takeovers, timelineEntries } from "../schema"

export async function resetOrderLiveState(orderId: string, options: { allFacts?: boolean } = {}): Promise<void> {
  const runs = await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.orderId, orderId))
  const runIds = runs.map((run) => run.id)
  const cardRows = await db.select({ id: cards.id, origin: cards.origin }).from(cards).where(eq(cards.orderId, orderId))
  const cardIds = cardRows.map((card) => card.id)
  await db.transaction(async (tx) => {
    if (runIds.length) await tx.delete(agentSteps).where(inArray(agentSteps.runId, runIds))
    if (runIds.length) await tx.delete(agentRuns).where(inArray(agentRuns.id, runIds))
    if (cardIds.length) {
      await tx.delete(decisions).where(inArray(decisions.cardId, cardIds))
      await tx.delete(pastDecisions).where(inArray(pastDecisions.cardId, cardIds))
      await tx.delete(evalCases).where(inArray(evalCases.cardId, cardIds))
    }
    await tx.delete(cards).where(and(eq(cards.orderId, orderId), eq(cards.origin, "agent")))
    await tx.update(cards).set({ status: "open" }).where(and(eq(cards.orderId, orderId), eq(cards.origin, "alert")))
    // Facts read from the dataset's own messages stay (unless the messages are read again); facts from live entries go with their entries.
    if (options.allFacts) await tx.delete(facts).where(and(eq(facts.orderId, orderId), inArray(facts.origin, ["classifier", "agent"])))
    else await tx.delete(facts).where(and(eq(facts.orderId, orderId), inArray(facts.origin, ["classifier", "agent"]),
      sql`${facts.sourceEntryId} in (select id from timeline_entries where order_id = ${orderId} and origin = 'live')`))
    await tx.delete(timelineEntries).where(and(eq(timelineEntries.orderId, orderId), eq(timelineEntries.origin, "live")))
    await tx.delete(demoEvents).where(eq(demoEvents.orderId, orderId))
    await tx.delete(takeovers).where(eq(takeovers.orderId, orderId))
  })
}

/** Forget people's decisions on one order and what the Executor did, and reopen its newest agent card. The agent's work stays. */
export async function resetOrderDecisions(orderId: string): Promise<void> {
  const cardRows = await db.select().from(cards).where(and(eq(cards.orderId, orderId), eq(cards.origin, "agent")))
  if (!cardRows.length) return
  const cardIds = cardRows.map((card) => card.id)
  const decisionRows = await db.select({ id: decisions.id }).from(decisions).where(inArray(decisions.cardId, cardIds))
  const decisionIds = decisionRows.map((row) => row.id)
  const newest = [...cardRows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
  await db.transaction(async (tx) => {
    if (decisionIds.length) {
      await tx.delete(timelineEntries).where(and(eq(timelineEntries.orderId, orderId), sql`${timelineEntries.evidence}->>'table' = 'decisions'`))
      await tx.delete(decisions).where(inArray(decisions.id, decisionIds))
      await tx.delete(pastDecisions).where(inArray(pastDecisions.id, decisionIds))
      await tx.delete(evalCases).where(inArray(evalCases.cardId, cardIds))
    }
    await tx.update(cards).set({ status: "open" }).where(eq(cards.id, newest.id))
    if (newest.runId) await tx.update(agentRuns).set({ status: "waiting_person", finishedAt: null }).where(eq(agentRuns.id, newest.runId))
  })
}

/** Forget all live work on every order, for a clean backfill: runs, agent cards, decisions, live entries and facts. */
export async function resetAllLiveState(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(agentSteps)
    await tx.delete(agentRuns)
    await tx.delete(decisions)
    await tx.delete(pastDecisions).where(eq(pastDecisions.origin, "live"))
    await tx.delete(evalCases)
    await tx.delete(cards).where(eq(cards.origin, "agent"))
    await tx.update(cards).set({ status: "open" }).where(eq(cards.origin, "alert"))
    await tx.delete(facts).where(inArray(facts.origin, ["classifier", "agent"]))
    await tx.delete(timelineEntries).where(eq(timelineEntries.origin, "live"))
    await tx.delete(demoEvents)
    await tx.delete(takeovers)
    await tx.update(policies).set({ approvedUnchangedCount: 0, decidedCount: 0 })
  })
}

/**
 * Forget the investigations on one order (Investigator and Driver support runs, their cards and decisions, and the
 * live entries, demo events and facts they wrote) and reopen its alert card. The Classifier's reading of the order's
 * own messages stays: `npm run agents:backfill -- --orders` investigates again without reading the messages again.
 */
export async function forgetInvestigations(orderId: string): Promise<void> {
  const runs = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.orderId, orderId), inArray(agentRuns.agent, ["Investigator", "Driver support"])))
  const runIds = runs.map((run) => run.id)
  const cardIds = (await db.select({ id: cards.id }).from(cards).where(and(eq(cards.orderId, orderId), eq(cards.origin, "agent")))).map((card) => card.id)
  await db.transaction(async (tx) => {
    if (runIds.length) await tx.delete(agentSteps).where(inArray(agentSteps.runId, runIds))
    if (runIds.length) await tx.delete(agentRuns).where(inArray(agentRuns.id, runIds))
    if (cardIds.length) {
      await tx.delete(decisions).where(inArray(decisions.cardId, cardIds))
      await tx.delete(pastDecisions).where(inArray(pastDecisions.cardId, cardIds))
      await tx.delete(evalCases).where(inArray(evalCases.cardId, cardIds))
      await tx.delete(cards).where(inArray(cards.id, cardIds))
    }
    await tx.update(cards).set({ status: "open" }).where(and(eq(cards.orderId, orderId), eq(cards.origin, "alert")))
    await tx.delete(facts).where(and(eq(facts.orderId, orderId), inArray(facts.origin, ["classifier", "agent"]),
      sql`${facts.sourceEntryId} in (select id from timeline_entries where order_id = ${orderId} and origin = 'live')`))
    await tx.delete(timelineEntries).where(and(eq(timelineEntries.orderId, orderId), eq(timelineEntries.origin, "live")))
    await tx.delete(demoEvents).where(eq(demoEvents.orderId, orderId))
  })
}
