// The Router (SPEC 7): code, not a model. After the Classifier has read a message,
// it decides what happens next: hand the message to a run that is waiting for this
// person, start the Investigator, let Driver support answer, or nothing.

import { and, desc, eq, inArray, or, sql } from "drizzle-orm"
import { getCase } from "./case"
import { db } from "./db"
import { autoReplyEnabled } from "./demo"
import type { Classification } from "./agents/classifier"
import { runDriverSupport } from "./agents/driver-support"
import { answerFromMessage, startInvestigation } from "./agents/investigator"
import { agentRuns, timelineEntries } from "./schema"
import { isSafety } from "./urgency"

export type RouteDecision = { action: "resumed" | "investigator" | "driver_support" | "nothing"; runId?: string; reason: string }

export type RouteInput = {
  /** Who wrote the message: driver, site_contact, customer, operator… */
  authorType: string | null
  classification: Pick<Classification, "urgency" | "needs"> | null
  /** The order already has a safety signal (a red warning light, a safety stop). */
  orderSafety: boolean
  /** An agent run is waiting for an answer from exactly this person on this order. */
  waitingRun: boolean
}

/** Where a classified message goes. Code, in this order: a waiting run, safety or risk, a driver's routine question, nothing. */
export function routeFor(input: RouteInput): RouteDecision["action"] {
  const fromDriver = input.authorType === "driver"
  if ((fromDriver || input.authorType === "site_contact") && input.waitingRun) return "resumed"
  if (input.classification?.urgency === "safety" || (fromDriver && input.orderSafety) || input.classification?.needs === "investigator") return "investigator"
  if (fromDriver && input.classification?.needs === "driver_support") return "driver_support"
  return "nothing"
}

export async function route(entryId: string, classification: Classification | null): Promise<RouteDecision> {
  const [entry] = await db.select().from(timelineEntries).where(eq(timelineEntries.id, entryId)).limit(1)
  if (!entry?.orderId) return { action: "nothing", reason: "The message is not linked to an order." }
  const file = await getCase(entry.orderId)
  if (!file) return { action: "nothing", reason: "Order not found." }
  const autoReply = await autoReplyEnabled()
  const fromDriver = entry.authorType === "driver"
  const fromSite = entry.authorType === "site_contact"

  // A run may be waiting for exactly this person: on this order, or covering it with others (one cause, several
  // orders) and waiting on this order's driver.
  const [waiting] = fromDriver || fromSite ? await db.select().from(agentRuns)
    .where(and(
      or(eq(agentRuns.orderId, entry.orderId), sql`${agentRuns.state}->'pending' @> ${JSON.stringify([{ orderId: entry.orderId }])}::jsonb`),
      eq(agentRuns.status, fromDriver ? "waiting_driver" : "waiting_site"),
    ))
    .orderBy(desc(agentRuns.startedAt)).limit(1) : []
  const action = routeFor({ authorType: entry.authorType, classification, orderSafety: isSafety(file), waitingRun: !!waiting })

  // 1. A run is waiting for exactly this person: the message is its answer.
  if (action === "resumed" && waiting) {
    const outcome = await answerFromMessage(waiting.id, entryId, { autoReply })
    return { action: "resumed", runId: waiting.id, reason: `The Investigator was waiting for this reply (${outcome?.status ?? "resumed"}).` }
  }

  const text = entry.body ?? entry.summary
  const who = entry.authorLabel ?? "Someone"
  // 2. Safety, risk or a change: the Investigator. Code picks Opus for safety inside startInvestigation.
  if (action === "investigator") {
    await supersedeWaitingRuns(entry.orderId)
    const outcome = await startInvestigation(file.order.reference, {
      trigger: `New message from ${who} (${entry.source === "driver_chat" ? "driver chat" : entry.source}): “${text}”. Classifier: ${classification?.reason ?? "safety signal on this order"}`,
      autoReply,
    })
    return { action: "investigator", runId: outcome.runId, reason: classification?.reason ?? "Safety signal on this order." }
  }
  // 3. A driver's routine question: Driver support answers, or hands over.
  if (action === "driver_support") {
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
