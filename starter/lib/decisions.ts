// Recording a person's decision on a card. Every decision lands on the order's
// timeline as a "person" entry. Phase 2 records the decision only; carrying out
// an approved action is the Executor's job (phase 5).

import { randomUUID } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import { now as clockNow } from "./clock"
import { db } from "./db"
import { cards, decisions, timelineEntries } from "./schema"

export class DecisionError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

const STATUS_FOR_ACTION: Record<string, "approved" | "rejected" | "answered"> = {
  approve: "approved",
  reject: "rejected",
  reply: "answered",
  mark_handled: "answered",
}

export async function decide(cardId: string, optionId: string, replyText: string | null, actor = "Ops") {
  const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1)
  if (!card) throw new DecisionError("This card no longer exists.", 404)
  if (card.status !== "open") throw new DecisionError("Someone already decided this card.", 409)
  const option = optionId === "reply"
    ? { id: "reply", label: "Reply sent to the agent", action: "reply", params: {} }
    : card.options.find((candidate) => candidate.id === optionId)
  if (!option) throw new DecisionError("That option is not on this card.")
  if (option.action === "reply" && !replyText?.trim()) throw new DecisionError("Write the reply first.")

  const at = await clockNow()
  const decisionId = `dec_${randomUUID()}`
  const status = STATUS_FOR_ACTION[option.action] ?? "approved"
  const summary = option.action === "mark_handled" ? `Marked as handled: ${card.headline}`
    : option.action === "reply" ? `Replied to the agent: “${replyText}”`
    : `${option.label}`
  await db.transaction(async (tx) => {
    await tx.insert(decisions).values({ id: decisionId, cardId, decidedAt: at, actor, choice: option.id, replyText: replyText ?? null, executedEffect: null })
    await tx.update(cards).set({ status }).where(eq(cards.id, cardId))
    await tx.insert(timelineEntries).values({
      id: `decision:${decisionId}`, orderId: card.orderId, occurredAt: at, receivedAt: at, source: "person", channel: "control_room",
      authorType: "operator", authorId: actor, authorLabel: actor, kind: "decision", summary, body: null, status: "done",
      visibility: "internal", evidence: { table: "decisions", id: decisionId }, origin: "live",
    })
  })
  const message = option.action === "mark_handled" ? "Marked as handled." : option.action === "reply" ? "Reply sent to the agent." : `${option.label}.`
  return { decisionId, message }
}

export async function undo(decisionId: string) {
  const [decision] = await db.select().from(decisions).where(and(eq(decisions.id, decisionId), isNull(decisions.undoneAt))).limit(1)
  if (!decision) throw new DecisionError("Nothing to undo.", 404)
  if (decision.executedEffect) throw new DecisionError("This was already carried out and cannot be undone here.", 409)
  const at = await clockNow()
  await db.transaction(async (tx) => {
    await tx.update(decisions).set({ undoneAt: at }).where(eq(decisions.id, decisionId))
    await tx.update(cards).set({ status: "open" }).where(eq(cards.id, decision.cardId))
    await tx.delete(timelineEntries).where(eq(timelineEntries.id, `decision:${decisionId}`))
  })
  return { ok: true }
}
