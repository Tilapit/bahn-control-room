// Take over: once Ops has an order, no agent acts on it, enforced in code, not in a prompt. The first part is pure.
// The second runs on the local database: it takes a delivered order (CD-420020, which no other test uses) over, then tries what an agent would do (a tool
// call, a new run, routing a driver's message), checks that nothing was written, and hands it back. It removes what
// it wrote, and is skipped when no database is reachable. No model is called: the key is unset for this file.

import "./setup"
// The hand-back would continue an agent live with a key; this test checks the rule, not a model.
delete process.env.ANTHROPIC_API_KEY
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { and, eq, gt, sql } from "drizzle-orm"
import { closeDb, db } from "@/lib/db"
import { agentBlocked, agentBlockedOn, handBack, openTakeovers, takeOver } from "@/lib/takeover"
import { agentRuns, orders, takeovers, timelineEntries } from "@/lib/schema"

describe("take over, the rule", () => {
  it("an open takeover blocks agents; a handed-back one does not; no takeover blocks nothing", () => {
    assert.match(agentBlocked({ takenBy: "Ops", handedBackAt: null }) ?? "", /Ops has taken this order over/)
    assert.equal(agentBlocked({ takenBy: "Ops", handedBackAt: new Date() }), null)
    assert.equal(agentBlocked(null), null)
  })
})

describe("take over, on the real paths an agent uses", async () => {
  const reachable = await db.execute(sql`select 1`).then(() => true, () => false)
  let orderId = ""
  let reference = ""
  const started = new Date()

  before(async () => {
    if (!reachable) return
    const [order] = await db.select({ id: orders.id, reference: orders.reference }).from(orders).where(eq(orders.reference, "CD-420020"))
    orderId = order.id
    reference = order.reference
    await db.delete(takeovers).where(eq(takeovers.orderId, orderId))
  })

  after(async () => {
    if (reachable) {
      await db.delete(takeovers).where(eq(takeovers.orderId, orderId))
      await db.delete(timelineEntries).where(and(eq(timelineEntries.orderId, orderId), eq(timelineEntries.origin, "live"), gt(timelineEntries.receivedAt, new Date(0)), sql`${timelineEntries.channel} in ('takeover', 'manual_action')`))
    }
    await closeDb()
  })

  it("the agent cannot act on a taken-over order: no tool runs, no run starts, no message is routed to an agent", { skip: !reachable && "no database" }, async () => {
    const taken = await takeOver(orderId, "Ops")
    assert.equal(taken.ok, true)
    assert.match(await agentBlockedOn([orderId]) ?? "", /taken this order over/)
    const entriesBefore = await db.select({ id: timelineEntries.id }).from(timelineEntries).where(eq(timelineEntries.orderId, orderId))

    // A tool call, as the Investigator's loop makes it: asking the driver would write a message and pause the run.
    const { executeTool, emptyDraft } = await import("@/lib/agents/tools")
    const { Refs } = await import("@/lib/agents/refs")
    const ctx = { runId: "test", orderId, reference, model: "", refs: new Refs(), lookups: {}, verifierRounds: 0, escalation: null, stepId: "test:0", file: null, usageExtra: [], draft: emptyDraft(), turnErrors: [], group: [orderId], trigger: "test", noReplySince: null }
    for (const [tool, input] of [["ask_driver", { question: "Where is the car?" }], ["ferry_options", {}], ["propose", { kind: "decision", headline: "test" }], ["resolve", { summary: "test", explained_by: ["E1"] }]] as const) {
      const outcome = await executeTool(ctx, tool, input)
      assert.equal(outcome.isError, true, tool)
      assert.match(outcome.content, /taken this order over/, tool)
      assert.equal(outcome.pause, undefined, tool)
      assert.equal(outcome.finish, undefined, tool)
    }

    // A new run: refused before any run row exists or any model is called.
    const { startInvestigation } = await import("@/lib/agents/investigator")
    const outcome = await startInvestigation(reference, { trigger: "test: a run on a taken-over order" })
    assert.equal(outcome.status, "paused")
    assert.equal(outcome.runId, "")
    assert.equal((await db.select().from(agentRuns).where(and(eq(agentRuns.orderId, orderId), gt(agentRuns.startedAt, started)))).length, 0)

    // A driver's message on the order: the Router hands it to no agent.
    const { route } = await import("@/lib/router")
    const [message] = await db.select({ id: timelineEntries.id }).from(timelineEntries).where(and(eq(timelineEntries.orderId, orderId), eq(timelineEntries.kind, "message"))).limit(1)
    if (message) assert.equal((await route(message.id, { intent: "question", urgency: "high", needs: "investigate" } as never)).action, "nothing")

    // Nothing an agent would write reached the order: only the takeover entry is new.
    const entriesAfter = await db.select({ id: timelineEntries.id, channel: timelineEntries.channel }).from(timelineEntries).where(eq(timelineEntries.orderId, orderId))
    const added = entriesAfter.filter((entry) => !entriesBefore.some((before) => before.id === entry.id))
    assert.deepEqual(added.map((entry) => entry.channel), [])

    // Handed back: agents may act again.
    const back = await handBack(orderId, "Ops", "Called the dealer myself; nothing else needed.")
    assert.equal(back.ok, true)
    assert.equal(await agentBlockedOn([orderId]), null)
    assert.equal((await openTakeovers([orderId])).length, 0)
  })
})
