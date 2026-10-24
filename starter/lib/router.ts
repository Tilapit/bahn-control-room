// The Router (SPEC 7): code, not a model. After the Classifier has read a message,
// it decides what happens next: hand the message to a run that is waiting for this
// person, start the Investigator, let Driver support answer, or nothing.

import { and, desc, eq, inArray } from "drizzle-orm"
import { getCase } from "./case"
import { db } from "./db"
import { autoReplyEnabled } from "./demo"
import type { Classification } from "./agents/classifier"
import { runDriverSupport } from "./agents/driver-support"
import { answerFromMessage, startInvestigation } from "./agents/investigator"
import { agentRuns, timelineEntries } from "./schema"
import { isSafety } from "./urgency"

export type RouteDecision = { action: "resumed" | "investigator" | "driver_support" | "nothing"; runId?: string; reason: string }

export async function route(entryId: string, classification: Classification | null): Promise<RouteDecision> {
  const [entry] = await db.select().from(timelineEntries).where(eq(timelineEntries.id, entryId)).limit(1)
  if (!entry?.orderId) return { action: "nothing", reason: "The message is not linked to an order." }
  const file = await getCase(entry.orderId)
  if (!file) return { action: "nothing", reason: "Order not found." }
  const autoReply = await autoReplyEnabled()
  const fromDriver = entry.authorType === "driver"
  const fromSite = entry.authorType === "site_contact"

  // 1. A run is waiting for exactly this person: the message is its answer.
  if (fromDriver || fromSite) {
    const [waiting] = await db.select().from(agentRuns)
      .where(and(eq(agentRuns.orderId, entry.orderId), eq(agentRuns.status, fromDriver ? "waiting_driver" : "waiting_site")))
      .orderBy(desc(agentRuns.startedAt)).limit(1)
    if (waiting) {
      const outcome = await answerFromMessage(waiting.id, entryId, { autoReply })
      return { action: "resumed", runId: waiting.id, reason: `The Investigator was waiting for this reply (${outcome?.status ?? "resumed"}).` }
    }
  }

  const text = entry.body ?? entry.summary
  const who = entry.authorLabel ?? "Someone"
  const safety = classification?.urgency === "safety" || (fromDriver && isSafety(file))
  // 2. Safety, risk or a change: the Investigator. Code picks Opus for safety inside startInvestigation.
  if (safety || classification?.needs === "investigator") {
    await supersedeWaitingRuns(entry.orderId)
    const outcome = await startInvestigation(file.order.reference, {
      trigger: `New message from ${who} (${entry.source === "driver_chat" ? "driver chat" : entry.source}): “${text}”. Classifier: ${classification?.reason ?? "safety signal on this order"}`,
      autoReply,
    })
    return { action: "investigator", runId: outcome.runId, reason: classification?.reason ?? "Safety signal on this order." }
  }
  // 3. A driver's routine question: Driver support answers, or hands over.
  if (fromDriver && classification?.needs === "driver_support") {
    const support = await runDriverSupport(file.order.reference, entryId, text)
    if (support.status === "handed_off" && support.handOff) {
      await supersedeWaitingRuns(entry.orderId)
      const outcome = await startInvestigation(file.order.reference, { trigger: support.handOff, autoReply })
      return { action: "investigator", runId: outcome.runId, reason: "Driver support handed it over." }
    }
    return { action: "driver_support", runId: support.runId, reason: "A routine question the records answer." }
  }
  return { action: "nothing", reason: classification?.reason ?? "Nothing to do." }
}

/** Runs still waiting on this order are replaced by the new investigation. */
async function supersedeWaitingRuns(orderId: string): Promise<void> {
  await db.update(agentRuns).set({ status: "done", outcomeSummary: "Replaced by a newer run after a new message" })
    .where(and(eq(agentRuns.orderId, orderId), inArray(agentRuns.status, ["waiting_driver", "waiting_site", "waiting_person"]), eq(agentRuns.agent, "Investigator")))
}
