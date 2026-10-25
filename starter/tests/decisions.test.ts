// The undo window (SPEC 8): an approved action is carried out only after 8 seconds; Undo inside the window cancels
// it and the card comes back; after the window it runs once and can no longer be undone from the toast.
// The first part is pure. The second runs the real decision path on the local database (a scratch card on a
// delivered order, removed afterwards) and is skipped when no database is reachable.

import "./setup"
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { eq, inArray, or, sql } from "drizzle-orm"
import { closeDb, db } from "@/lib/db"
import { canUndo, decide, finalizeDecision, isDue, undo, UNDO_SECONDS } from "@/lib/decisions"
import { cards, decisions, orders, pastDecisions, policies, timelineEntries } from "@/lib/schema"
import type { CardOption } from "@/lib/schema"

const T = Date.parse("2026-10-25T10:00:00Z")
const decision = (executeAfterMs: number | null, extra: { finalizedAt?: Date | null; undoneAt?: Date | null } = {}) => ({
  executeAfter: executeAfterMs == null ? null : new Date(executeAfterMs), finalizedAt: extra.finalizedAt ?? null, undoneAt: extra.undoneAt ?? null,
})

describe("undo window, the rule", () => {
  it("is 8 seconds", () => assert.equal(UNDO_SECONDS, 8))

  it("inside the window: can be undone, is not carried out", () => {
    const d = decision(T + 8000)
    assert.equal(canUndo(d, T), true)
    assert.equal(canUndo(d, T + 7999), true)
    assert.equal(isDue(d, T), false)
    assert.equal(isDue(d, T + 7999), false)
  })

  it("after the window: carried out, no longer undone from the toast", () => {
    const d = decision(T + 8000)
    assert.equal(isDue(d, T + 8000), true)
    assert.equal(canUndo(d, T + 8001), false)
  })

  it("an undone decision is never carried out, and one carried out never twice", () => {
    assert.equal(isDue(decision(T, { undoneAt: new Date(T) }), T + 60_000), false)
    assert.equal(isDue(decision(T, { finalizedAt: new Date(T + 8000) }), T + 60_000), false)
    assert.equal(canUndo(decision(T + 8000, { finalizedAt: new Date(T) }), T), false)
  })
})

describe("undo window, on the real decision path", async () => {
  const reachable = await db.execute(sql`select 1`).then(() => true, () => false)
  const cardId = `card_test_${Date.now()}`
  let orderId = ""
  let policyRows: (typeof policies.$inferSelect)[] = []
  const decided: string[] = []
  // What the Executor wrote: entries that point at one of this card's decisions, other than the decision itself ("Approved: …").
  const executorEntries = async () => db.select().from(timelineEntries).where(sql`${timelineEntries.evidence}->>'table' = 'decisions' and ${timelineEntries.evidence}->>'id' in (select id from decisions where card_id = ${cardId}) and ${timelineEntries.id} not like 'decision:%'`)
  const cardStatus = async () => (await db.select({ status: cards.status }).from(cards).where(eq(cards.id, cardId)))[0]?.status

  before(async () => {
    if (!reachable) return
    const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.reference, "CD-420004"))
    orderId = order.id
    policyRows = await db.select().from(policies)
    // What an agent card proposing a customer email and a call looks like. Created open: nothing is carried out yet.
    const options: CardOption[] = [
      { id: "opt-1", label: "Approve: email the customer and call the seller", action: "message_customer", params: {}, kind: "approve", effect_text: "Sends the email and puts the call on a person's list.", steps: [
        { action: "message_customer", params: { to: "the customer", text: "Test email from the undo-window test. Not sent anywhere." } },
        { action: "call_contact", params: { to: "the seller", text: "Test call from the undo-window test." } },
      ] },
      { id: "reject", label: "Reject", action: "reject", params: {}, kind: "reject" },
    ]
    await db.insert(cards).values({ id: cardId, orderId, runId: null, createdAt: new Date(), kind: "decision", status: "open", headline: "Volvo V60: undo-window test", whatHappened: "Test card.", findings: [], proposal: null, options, severity: "normal", origin: "agent" })
  })

  after(async () => {
    if (!reachable) return closeDb()
    const ids = (await db.select({ id: decisions.id }).from(decisions).where(eq(decisions.cardId, cardId))).map((row) => row.id)
    if (ids.length) {
      await db.delete(timelineEntries).where(or(inArray(timelineEntries.id, ids.map((id) => `decision:${id}`)), sql`${timelineEntries.evidence}->>'table' = 'decisions' and ${timelineEntries.evidence}->>'id' in ${ids}`))
      await db.delete(decisions).where(inArray(decisions.id, ids))
    }
    await db.delete(cards).where(eq(cards.id, cardId))
    await db.delete(pastDecisions).where(eq(pastDecisions.cardId, cardId))
    // The approval moved the "approved unchanged" counters; put them back as they were.
    for (const row of policyRows) await db.update(policies).set({ approvedUnchangedCount: row.approvedUnchangedCount, decidedCount: row.decidedCount }).where(eq(policies.action, row.action))
    await closeDb()
  })

  it("Undo inside the window brings the card back and nothing is carried out", { skip: !reachable && "no database" }, async () => {
    const first = await decide(cardId, "opt-1", null)
    decided.push(first.decisionId)
    assert.match(first.message, /^Sending the email in 8 s$/)
    assert.equal(await cardStatus(), "approved")
    assert.deepEqual(await finalizeDecision(first.decisionId), { done: false }, "not carried out inside the window")
    await undo(first.decisionId)
    assert.equal(await cardStatus(), "open")
    assert.equal((await executorEntries()).length, 0)
  })

  it("after 8 seconds it is carried out once, and Undo is refused", { skip: !reachable && "no database", timeout: 30_000 }, async () => {
    const second = await decide(cardId, "opt-1", null)
    decided.push(second.decisionId)
    assert.equal((await executorEntries()).length, 0, "nothing runs at the moment of approval")
    // The server's own timer carries it out when the window closes.
    const until = Date.now() + 15_000
    let row: typeof decisions.$inferSelect | undefined
    while (Date.now() < until) {
      ;[row] = await db.select().from(decisions).where(eq(decisions.id, second.decisionId))
      if (row?.executedEffect) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.ok(row?.finalizedAt, "carried out")
    assert.ok(row!.finalizedAt!.getTime() > 0)
    assert.equal(row!.executedEffect?.ok, true)
    assert.deepEqual(row!.executedEffect?.steps.map((step) => step.action), ["message_customer", "call_contact"])
    assert.equal((await executorEntries()).length, 2)
    assert.deepEqual(await finalizeDecision(second.decisionId), { done: false }, "never twice")
    await assert.rejects(undo(second.decisionId), /cannot be undone/)
    // The first, undone decision's timer has fired by now too: it did nothing.
    const [first] = await db.select().from(decisions).where(eq(decisions.id, decided[0]))
    assert.equal(first.finalizedAt, null)
  })
})
