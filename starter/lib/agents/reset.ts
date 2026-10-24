// Test and demo helper: forget everything agents, people and the demo did live on
// one order (runs, steps, agent cards, decisions, live timeline entries, demo
// events) and reopen its temporary alert card. The dataset itself is untouched.

import { and, eq, inArray, sql } from "drizzle-orm"
import { db } from "../db"
import { agentRuns, agentSteps, cards, decisions, demoEvents, evalCases, facts, timelineEntries } from "../schema"

export async function resetOrderLiveState(orderId: string): Promise<void> {
  const runs = await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.orderId, orderId))
  const runIds = runs.map((run) => run.id)
  const cardRows = await db.select({ id: cards.id, origin: cards.origin }).from(cards).where(eq(cards.orderId, orderId))
  const cardIds = cardRows.map((card) => card.id)
  await db.transaction(async (tx) => {
    if (runIds.length) await tx.delete(agentSteps).where(inArray(agentSteps.runId, runIds))
    if (runIds.length) await tx.delete(agentRuns).where(inArray(agentRuns.id, runIds))
    if (cardIds.length) {
      await tx.delete(decisions).where(inArray(decisions.cardId, cardIds))
      await tx.delete(evalCases).where(inArray(evalCases.cardId, cardIds))
    }
    await tx.delete(cards).where(and(eq(cards.orderId, orderId), eq(cards.origin, "agent")))
    await tx.update(cards).set({ status: "open" }).where(and(eq(cards.orderId, orderId), eq(cards.origin, "alert")))
    // Facts read from the dataset's own messages stay; facts from live entries go with their entries.
    await tx.delete(facts).where(and(eq(facts.orderId, orderId), inArray(facts.origin, ["classifier", "agent"]),
      sql`${facts.sourceEntryId} in (select id from timeline_entries where order_id = ${orderId} and origin = 'live')`))
    await tx.delete(timelineEntries).where(and(eq(timelineEntries.orderId, orderId), eq(timelineEntries.origin, "live")))
    await tx.delete(demoEvents).where(eq(demoEvents.orderId, orderId))
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
      await tx.delete(evalCases).where(inArray(evalCases.cardId, cardIds))
    }
    await tx.update(cards).set({ status: "open" }).where(eq(cards.id, newest.id))
    if (newest.runId) await tx.update(agentRuns).set({ status: "waiting_person", finishedAt: null }).where(eq(agentRuns.id, newest.runId))
  })
}
