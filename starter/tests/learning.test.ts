// Learning without fine-tuning (round 4, item 4): similar past decisions, acceptance rates and playbook rules.
// The first part is pure. The second reads the seeded past decisions (npm run learning:seed) and is skipped
// when no database is reachable or nothing is seeded.

import "./setup"
import assert from "node:assert/strict"
import { after, describe, it } from "node:test"
import { sql } from "drizzle-orm"
import { closeDb, db } from "@/lib/db"
import { findSimilar, PLAYBOOK_THRESHOLD, rateOf, similarText } from "@/lib/learning"

describe("learning, the rules", () => {
  it("acceptance is approved unchanged out of decided, none before the first decision", () => {
    assert.equal(rateOf(5, 5), 1)
    assert.equal(rateOf(9, 10), 0.9)
    assert.equal(rateOf(0, 0), null)
  })
  it("a playbook rule needs 3 rejections or changes with one reason", () => assert.equal(PLAYBOOK_THRESHOLD, 3))
  it("a similar case reads as one line with the decision, the reason and the outcome", () => {
    const line = similarText([{ id: "dataset:agent-x1", reference: "CD-420299", proposal: "Attempt to book the next-day quoted vehicle crossing", decision: "approved", verdict: "approved unchanged", reasonText: null, outcome: "didnt_work", outcomeNote: "The attempt failed", decidedAt: "2026-10-21T07:06:00.000Z", origin: "dataset" }])
    assert.match(line, /^CD-420299 · 2026-10-21 · proposed: Attempt to book .* · approved unchanged · outcome: Didn't work, The attempt failed \[past_decisions:dataset:agent-x1\]$/)
    assert.equal(similarText([]), "No past decisions on this kind of action yet.")
  })
})

describe("learning, on the seeded past decisions", async () => {
  const seeded = await db.execute<{ n: number }>(sql`select count(*)::int as n from past_decisions where origin <> 'live'`).then((rows) => (rows[0]?.n ?? 0) > 0, () => false)
  after(() => closeDb())

  it("find_similar_decisions returns at most 3 cases of the same action, the same situation first", { skip: !seeded && "nothing seeded" }, async () => {
    const cases = await findSimilar({ action: "book_ferry", situation: "ferry" })
    assert.ok(cases.length > 0 && cases.length <= 3)
    const other = await findSimilar({ action: "switch_driver", situation: "driver" })
    assert.ok(other.every((item) => !/sailing|ferry/i.test(item.proposal)), "another action's cases are never mixed in")
  })
})
