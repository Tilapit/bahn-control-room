// Take over: Ops handles an order themselves. Until a person hands it back, no agent and no Monitor rule acts on it.
// Enforced here, in code: the Investigator's loop and every one of its tools, starting a run, Driver support, the
// Router (and the Classifier behind it) and the Monitor ask this module first. A person's own decisions on the
// order's card still go through: approving one is the person acting, and the Executor carries it out as usual.

import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { now as clockNow } from "./clock"
import { db } from "./db"
import { writeEntry } from "./agents/entries"
import { agentRuns, takeovers } from "./schema"

export type Takeover = typeof takeovers.$inferSelect

/** Why an agent may not act on the order, or null. A takeover holds until a person hands the order back. */
export function agentBlocked(takeover: Pick<Takeover, "takenBy" | "handedBackAt"> | null | undefined): string | null {
  if (!takeover || takeover.handedBackAt) return null
  return `${takeover.takenBy} has taken this order over and is handling it.`
}

/** The takeovers still open: of these orders, or of every order. */
export async function openTakeovers(orderIds?: string[]): Promise<Takeover[]> {
  if (orderIds && !orderIds.length) return []
  return db.select().from(takeovers)
    .where(and(isNull(takeovers.handedBackAt), orderIds ? inArray(takeovers.orderId, orderIds) : undefined))
    .orderBy(desc(takeovers.takenAt))
}

/** Why no agent may act on any of these orders now, or null. Every agent path calls this before it acts. */
export async function agentBlockedOn(orderIds: (string | null | undefined)[]): Promise<string | null> {
  const ids = orderIds.filter((id): id is string => !!id)
  if (!ids.length) return null
  const [open] = await openTakeovers(ids)
  return agentBlocked(open ?? null)
}

/** Runs that work on an order or wait for an answer: a takeover stops them where they are, conversation kept. */
const ACTIVE = ["running", "waiting_driver", "waiting_site"]

export async function takeOver(orderId: string, actor: string): Promise<{ ok: boolean; message: string }> {
  if ((await openTakeovers([orderId])).length) return { ok: false, message: "This order is already taken over." }
  const at = await clockNow()
  const id = `tko_${randomUUID().slice(0, 12)}`
  await db.insert(takeovers).values({ id, orderId, takenAt: at, takenBy: actor })
  const paused = await db.update(agentRuns).set({ status: "paused", nextCheckAt: null, outcomeSummary: `Paused: ${actor} took the order over.` })
    .where(and(eq(agentRuns.orderId, orderId), inArray(agentRuns.status, ACTIVE))).returning({ id: agentRuns.id })
  await writeEntry({
    orderId, at, source: "person", channel: "takeover", authorType: "operator", authorLabel: actor, kind: "event", status: "done",
    summary: `${actor} took this order over: agents and Monitor rules leave it alone until it is handed back${paused.length ? ` (${paused.length} agent run${paused.length === 1 ? "" : "s"} paused)` : ""}`,
    evidence: { table: "takeovers", id },
  })
  return { ok: true, message: "You have this order. Agents are paused on it." }
}

/** Something the person did while they had the order, on its timeline in their name. */
export async function logAction(orderId: string, actor: string, text: string): Promise<{ ok: boolean; message: string }> {
  const [open] = await openTakeovers([orderId])
  if (!text.trim()) return { ok: false, message: "Write what you did first." }
  await writeEntry({
    orderId, at: await clockNow(), source: "person", channel: "manual_action", authorType: "operator", authorLabel: actor, kind: "event", status: "done",
    summary: text.trim(), evidence: { table: "takeovers", id: open?.id ?? orderId },
  })
  return { ok: true, message: "On the order's timeline." }
}

/**
 * Hand the order back. The agent continues with what the person did: its paused or waiting run if there is one,
 * otherwise a new run when the order still has something open. Without an API key the hand-back is only recorded.
 */
export async function handBack(orderId: string, actor: string, note: string): Promise<{ ok: boolean; message: string }> {
  const [open] = await openTakeovers([orderId])
  if (!open) return { ok: false, message: "This order is not taken over." }
  const at = await clockNow()
  const text = note.trim()
  await db.update(takeovers).set({ handedBackAt: at, handedBackBy: actor, note: text || null }).where(eq(takeovers.id, open.id))
  await writeEntry({
    orderId, at, source: "person", channel: "takeover", authorType: "operator", authorLabel: actor, kind: "event", status: "done",
    summary: `${actor} handed the order back to the agents${text ? `: “${text}”` : ", without a note"}`, evidence: { table: "takeovers", id: open.id },
  })
  const { hasApiKey } = await import("./agents/llm")
  if (!hasApiKey()) return { ok: true, message: "Handed back. Agents are not running live here (no API key), so none continued." }
  const minutes = Math.round((at.getTime() - open.takenAt.getTime()) / 60_000)
  const content = `${actor} took this order over and handled it themselves for ${minutes} minutes; no agent acted meanwhile. ${text ? `What they did, in their words: "${text}".` : "They left no note."} Read the order again with get_case (anything that came in meanwhile is on it), then propose or resolve.`
  void continueAgent(orderId, content).catch((error) => console.error("hand back", error))
  return { ok: true, message: "Handed back. The agent continues with your note." }
}

async function continueAgent(orderId: string, content: string): Promise<void> {
  const { continueAfterHandBack, startInvestigation } = await import("./agents/investigator")
  const [run] = await db.select().from(agentRuns)
    .where(and(eq(agentRuns.orderId, orderId), eq(agentRuns.agent, "Investigator"), inArray(agentRuns.status, ["paused", "waiting_driver", "waiting_site", "waiting_person"])))
    .orderBy(desc(agentRuns.startedAt)).limit(1)
  const { autoReplyEnabled } = await import("./demo")
  if (run && await continueAfterHandBack(run.id, content, { autoReply: await autoReplyEnabled() })) return
  const { getCase } = await import("./case")
  const { liveSignals } = await import("./signals")
  const file = await getCase(orderId)
  if (file && liveSignals(file).length) await startInvestigation(file.order.reference, { trigger: `Handed back by a person. ${content}`, autoReply: await autoReplyEnabled() })
}
