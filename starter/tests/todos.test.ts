// To-dos (asked for by Bahn's ops person): an approved card with a call the person makes stays a to-do until they log
// what happened. A log needs words, checked in code before anything is written. The second part runs the real
// to-do path on a scratch card and decision (removed afterwards) and only exercises the refusals: a valid log would
// call the Classifier and start an agent.

import "./setup"
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { eq, sql } from "drizzle-orm"
import { closeDb, db } from "@/lib/db"
import { cards, decisions, orders, timelineEntries, todoLogs } from "@/lib/schema"
import type { CardOption } from "@/lib/schema"
import { simulatedCall } from "@/lib/sim-call"
import { callStep, callTodo, isOpenTodo, logTodo, noteError, openTodos, TodoError } from "@/lib/todos"

const call: CardOption = {
  id: "opt-1", label: "Approve: call the dealer about recovery", action: "call_customer", params: { to: "Marvellin Motorhandel (service contact)", text: "Ask who collects the car." }, kind: "approve",
  steps: [{ action: "call_customer", params: { to: "Marvellin Motorhandel (service contact)", text: "Ask who collects the car." } }, { action: "message_driver", params: { text: "Please wait." } }],
}
const booking: CardOption = { id: "opt-2", label: "Book the 14:00 ferry", action: "book_ferry", params: {}, kind: "approve", steps: [{ action: "book_ferry", params: {} }] }
const done = { finalizedAt: new Date("2026-10-21T10:00:00Z"), undoneAt: null, executedEffect: { ok: true, steps: [] } }

describe("to-dos, the rule", () => {
  it("a call the person makes is the step that makes a to-do; a booking is not", () => {
    assert.equal(callStep(call)?.action, "call_customer")
    assert.equal(callStep({ action: "call_contact", params: { to: "the Vantaa yard" } })?.action, "call_contact")
    assert.equal(callStep(booking), null)
  })
  it("open only when carried out, not undone, the Executor said ok, and nobody logged it", () => {
    assert.equal(isOpenTodo({ ...done, choice: "opt-1" }, [call, booking], false), true)
    assert.equal(isOpenTodo({ ...done, choice: "opt-1" }, [call, booking], true), false, "already logged")
    assert.equal(isOpenTodo({ ...done, choice: "opt-2" }, [call, booking], false), false, "no call in the chosen option")
    assert.equal(isOpenTodo({ ...done, choice: "opt-1", finalizedAt: null }, [call], false), false, "still in the undo window")
    assert.equal(isOpenTodo({ ...done, choice: "opt-1", undoneAt: new Date() }, [call], false), false, "undone")
    assert.equal(isOpenTodo({ ...done, choice: "opt-1", executedEffect: { ok: false } }, [call], false), false, "not carried out")
  })
  it("the demo has a simulated call only where it wrote one (the Bentley's owner, CD-420322)", () => {
    const script = simulatedCall("CD-420322")
    assert.ok(script && script.lines.some((line) => line.who === "them"))
    assert.equal(simulatedCall("CD-420004"), null)
  })
  it("a log needs words: empty, blank or a word or two is refused", () => {
    for (const note of ["", "   ", "ok", "done.", null, undefined]) assert.ok(noteError(note), `refused: ${JSON.stringify(note)}`)
    assert.equal(noteError("Spoke to Eva at Marvellin: their service partner collects the car at 15:00."), null)
  })
})

describe("to-dos, on the real path", async () => {
  const reachable = await db.execute(sql`select 1`).then(() => true, () => false)
  const stamp = Date.now()
  const cardId = `card_todo_${stamp}`
  const decisionId = `dec_todo_${stamp}`
  before(async () => {
    if (!reachable) return
    const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.reference, "CD-420004"))
    await db.insert(cards).values({ id: cardId, orderId: order.id, runId: null, createdAt: new Date(), kind: "decision", status: "approved", headline: "Volvo V60: to-do test", whatHappened: "Test card.", findings: [], proposal: null, options: [call, booking], severity: "normal", origin: "agent" })
    await db.insert(decisions).values({ id: decisionId, cardId, decidedAt: new Date("2026-10-21T09:58:00Z"), actor: "Ops", choice: "opt-1", replyText: null, executedEffect: { ok: true, steps: [], bookings: [], windows: [] }, executeAfter: new Date(), finalizedAt: new Date("2026-10-21T09:58:08Z"), label: "positive" })
  })
  after(async () => {
    if (reachable) {
      await db.delete(todoLogs).where(eq(todoLogs.decisionId, decisionId))
      await db.delete(timelineEntries).where(eq(timelineEntries.id, `todo:${decisionId}`))
      await db.delete(decisions).where(eq(decisions.id, decisionId))
      await db.delete(cards).where(eq(cards.id, cardId))
    }
    await closeDb()
  })

  it("the approved call is an open to-do, named by who to call", { skip: !reachable && "no database" }, async () => {
    const todo = (await openTodos()).find((item) => item.id === decisionId)
    assert.ok(todo, "listed")
    assert.equal(todo.contact, "Marvellin Motorhandel")
    assert.equal(todo.script, "Ask who collects the car.")
  })

  it("cannot be done without a log: nothing is written, and it stays open", { skip: !reachable && "no database" }, async () => {
    for (const note of ["", "   ", "ok"]) {
      await assert.rejects(logTodo(decisionId, note), (error: unknown) => error instanceof TodoError && error.status === 400)
    }
    assert.equal((await db.select().from(todoLogs).where(eq(todoLogs.decisionId, decisionId))).length, 0, "no log row")
    assert.equal((await db.select().from(timelineEntries).where(eq(timelineEntries.id, `todo:${decisionId}`))).length, 0, "no timeline entry")
    assert.ok((await openTodos()).some((item) => item.id === decisionId), "still a to-do")
  })

  it("a simulated call is refused on an order without a script, and nothing is written", { skip: !reachable && "no database" }, async () => {
    await assert.rejects(callTodo(decisionId, 5), (error: unknown) => error instanceof TodoError && /no simulated call/.test(error.message))
    assert.equal((await db.select().from(todoLogs).where(eq(todoLogs.decisionId, decisionId))).length, 0)
  })
})
