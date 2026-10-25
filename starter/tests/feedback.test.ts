// Decision feedback (round 4, item 3): rejecting or changing a proposal needs exactly one reason, enforced in code
// by the decision path; approving the agent's own first option is a positive label. The second part runs the real
// decision path on a scratch card (removed afterwards; every decision is undone inside its window, so nothing runs).

import "./setup"
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { eq, inArray, sql } from "drizzle-orm"
import { closeDb, db } from "@/lib/db"
import { decide, undo } from "@/lib/decisions"
import { feedbackError, feedbackRule, situationOf } from "@/lib/outcomes"
import { cards, decisions, orders, timelineEntries } from "@/lib/schema"
import type { CardOption } from "@/lib/schema"

describe("decision feedback, the rule", () => {
  it("approving the agent's own proposal is positive and needs no reason", () => {
    assert.deepEqual(feedbackRule("approve", true), { label: "positive", needsReason: false })
  })
  it("rejecting, replying or choosing another option is negative and needs a reason", () => {
    for (const rule of [feedbackRule("reject", false), feedbackRule("reply", false), feedbackRule("approve", false)]) {
      assert.deepEqual(rule, { label: "negative", needsReason: true })
      assert.match(feedbackError(rule, {}) ?? "", /Pick one reason first/)
      assert.match(feedbackError(rule, { reason: "because" }) ?? "", /not one of the five/)
      assert.equal(feedbackError(rule, { reason: "too_expensive", reasonText: "a cheaper sailing meets the promise" }), null)
    }
  })
  it("an answer to the agent's question carries no label", () => {
    assert.deepEqual(feedbackRule("answer", true), { label: null, needsReason: false })
  })
  it("situations are read from the card's words", () => {
    assert.equal(situationOf("ferry sold out; Sat 14:00 sailing has space"), "ferry_sold_out")
    assert.equal(situationOf("Car stopped: red warning light"), "car_problem")
    assert.equal(situationOf("Driver may be ill; backup driver prepared"), "driver")
  })
})

describe("decision feedback, on the real decision path", async () => {
  const reachable = await db.execute(sql`select 1`).then(() => true, () => false)
  const cardId = `card_feedback_${Date.now()}`
  before(async () => {
    if (!reachable) return
    const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.reference, "CD-420004"))
    const options: CardOption[] = [
      { id: "opt-1", label: "Approve: book the 14:00 ferry", action: "book_ferry", params: {}, kind: "approve", steps: [{ action: "book_ferry", params: {} }] },
      { id: "opt-2", label: "Book the 18:00 ferry instead", action: "book_ferry", params: {}, kind: "approve", steps: [{ action: "book_ferry", params: {} }] },
      { id: "reject", label: "Reject", action: "reject", params: {}, kind: "reject" },
    ]
    await db.insert(cards).values({ id: cardId, orderId: order.id, runId: null, createdAt: new Date(), kind: "decision", status: "open", headline: "Volvo V60: feedback test", whatHappened: "Test card.", findings: [], proposal: null, options, severity: "normal", origin: "agent" })
  })
  after(async () => {
    if (!reachable) return closeDb()
    const ids = (await db.select({ id: decisions.id }).from(decisions).where(eq(decisions.cardId, cardId))).map((row) => row.id)
    if (ids.length) {
      await db.delete(timelineEntries).where(inArray(timelineEntries.id, ids.map((id) => `decision:${id}`)))
      await db.delete(decisions).where(inArray(decisions.id, ids))
    }
    await db.delete(cards).where(eq(cards.id, cardId))
    // The undone decisions' own timers still fire after 8 seconds (and do nothing); let them, before closing.
    await new Promise((resolve) => setTimeout(resolve, 8_600))
    await closeDb()
  })

  it("a reject without a reason is refused; with one it is kept with the reason", { skip: !reachable && "no database" }, async () => {
    await assert.rejects(decide(cardId, "reject", null), /Pick one reason first/)
    await assert.rejects(decide(cardId, "opt-2", null), /Pick one reason first/, "another option is a change")
    await assert.rejects(decide(cardId, "reply", "book the later one", { reason: "cheap" }), /not one of the five/)
    const rejected = await decide(cardId, "reject", null, { reason: "too_expensive", reasonText: "the 18:00 sailing is €90 cheaper" })
    const [row] = await db.select().from(decisions).where(eq(decisions.id, rejected.decisionId))
    assert.equal(row.reason, "too_expensive")
    assert.equal(row.reasonText, "the 18:00 sailing is €90 cheaper")
    assert.equal(row.label, "negative")
    await undo(rejected.decisionId)
  })

  it("approving the proposal unchanged is a positive label, with no reason", { skip: !reachable && "no database" }, async () => {
    const approved = await decide(cardId, "opt-1", null, { reason: "too_early" })
    const [row] = await db.select().from(decisions).where(eq(decisions.id, approved.decisionId))
    assert.equal(row.label, "positive")
    assert.equal(row.reason, null, "a reason sent with an unchanged approval is not kept")
    await undo(approved.decisionId)
  })
})
