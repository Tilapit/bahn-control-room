// Policies (SPEC 2, 7): what an agent may do on its own is decided by code from the policies table, never by a
// prompt. Nothing that books, costs money, changes a date or contacts a customer runs without a person's approval.

import "./setup"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import { TOOL_DEFINITIONS } from "@/lib/agents/tools"
import { ACTIONS, describe as policy, effectiveLevel, gigOf, NEVER_AUTO, refusal, waitsForBackup } from "@/lib/policies"
import { caseFile } from "./helpers"

/** Every action that books, costs money, changes a date or contacts someone on our behalf. */
const CHANGES_SOMETHING = ["book_ferry", "change_ferry_booking", "book_hotel", "book_driver_travel", "cancel_driver_travel", "switch_driver", "republish_offer", "raise_fee", "change_pickup_time", "change_delivery_time", "book_tow", "approve_repair_cost", "message_customer", "call_customer", "call_contact"]
const CUSTOMER_CONTACT = ["message_customer", "call_customer"]

describe("policies", () => {
  it("reading, asking a driver or a site and looking things up need no approval", () => {
    for (const action of ["read", "ask_driver", "ask_site", "look_up", "reply_driver"]) assert.equal(effectiveLevel(action, null), "auto", action)
  })

  it("everything that books, costs, changes a date or contacts a customer asks a person first, as shipped", () => {
    for (const action of CHANGES_SOMETHING) {
      assert.ok(policy(action), `${action} is in the table`)
      assert.equal(effectiveLevel(action, null), "approval", action)
    }
  })

  it("an action the table does not know is never allowed", () => {
    for (const action of ["book_flight", "pay_driver", "email_customer", "", "DROP TABLE"]) assert.equal(effectiveLevel(action, null), "never", action)
  })

  it("customer contact and a promised delivery date stay with a person even if the table row says automatic", () => {
    for (const action of [...CUSTOMER_CONTACT, "change_delivery_time"]) {
      assert.equal(effectiveLevel(action, { level: "auto", autoLimitEur: null }), "approval", action)
      assert.equal(effectiveLevel(action, { level: "auto", autoLimitEur: 10_000 }, 1), "approval", action)
      assert.ok(NEVER_AUTO.has(action))
    }
  })

  it("a person cannot make customer contact or a promised date automatic", () => {
    for (const action of [...CUSTOMER_CONTACT, "change_delivery_time"]) assert.match(refusal(action, "auto") ?? "", /always needs a person/)
    assert.equal(refusal("book_ferry", "auto"), null)
    assert.equal(refusal("message_customer", "approval"), null)
  })

  it("an automatic action with a cost limit asks again above the limit, and when the cost is not known", () => {
    const row = { level: "auto", autoLimitEur: 400 }
    assert.equal(effectiveLevel("book_ferry", row, 387), "auto")
    assert.equal(effectiveLevel("book_ferry", row, 400), "auto")
    assert.equal(effectiveLevel("book_ferry", row, 401), "approval")
    assert.equal(effectiveLevel("book_ferry", row, null), "approval")
    assert.equal(effectiveLevel("book_ferry", { level: "auto", autoLimitEur: null }, 2000), "auto")
  })

  it("no agent tool books, pays or contacts a customer: those are only ever options on a card", () => {
    const tools = TOOL_DEFINITIONS.map((tool) => tool.name)
    for (const action of CHANGES_SOMETHING) assert.ok(!tools.includes(action), `${action} is not a tool`)
    for (const name of tools) assert.doesNotMatch(name, /^(book|pay|charge|email|message|call|cancel|change|switch|republish|raise|approve)/, name)
    // The whole tool belt: read, ask a driver or a site, look things up, move to the senior model, put a card together or close.
    // A new tool has to be added here on purpose.
    assert.deepEqual([...tools].sort(), [
      "add_affected_order", "add_finding", "add_step", "ask_driver", "ask_site", "check_disruptions", "escalate", "ferry_booking_status", "ferry_options",
      "find_backup_drivers", "find_repair_shops", "get_case", "hotel_options", "propose", "resolve", "search", "timeline", "travel_options",
    ])
    // What the agent can do directly: read, ask a driver or site, look up, and put a card together (or close).
    const shipped = new Map(ACTIONS.map((entry) => [entry.action, entry.level]))
    for (const action of CHANGES_SOMETHING) assert.equal(shipped.get(action), "approval", action)
  })

  it("only two places in the code can run the Executor: a person's decision after the undo window, and a person's own rule", () => {
    const root = join(process.cwd())
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", "tests"].includes(name)) continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(name)) files.push(path)
      }
    }
    for (const dir of ["lib", "app", "scripts"]) walk(join(root, dir))
    const importers = files.filter((file) => !file.endsWith(join("lib", "executor.ts")) && /from "(?:\.\.?\/|@\/lib\/)+executor"|import\("(?:\.\.?\/|@\/lib\/)+executor"\)/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(root.length + 1)).sort()
    assert.deepEqual(importers, [join("lib", "agents", "propose.ts"), join("lib", "decisions.ts")])
    // In propose, the Executor runs only when every step of the option is automatic under a rule a person set.
    const propose = readFileSync(join(root, "lib", "agents", "propose.ts"), "utf8")
    assert.match(propose, /const byRule = [^\n]*\n[^\n]*levelForAll\([^\n]*=== "auto"/)
    assert.match(propose, /if \(byRule\) return carryOutByRule/)
  })
})

describe("policies: a call is always a person's", () => {
  it("calling a seller or other contact never becomes automatic, whatever the table says", () => {
    assert.equal(effectiveLevel("call_contact", { level: "auto", autoLimitEur: null } as never, null), "approval")
    assert.ok(NEVER_AUTO.has("call_contact"))
  })
})

describe("policies: the current driver's travel waits for a backup's yes", () => {
  const holds = { driverHoldsGig: true, offeredTo: null }

  it("an option that offers the gig and cancels the current driver's travel is refused (the CD-420449 live run)", () => {
    assert.match(waitsForBackup(["switch_driver", "cancel_driver_travel", "message_driver"], holds) ?? "", /stays booked until a backup driver has accepted/)
    assert.match(waitsForBackup(["republish_offer", "raise_fee", "cancel_driver_travel"], holds) ?? "", /stays booked/)
  })

  it("while an offer is open and nobody has accepted, cancelling the travel on its own is refused too", () => {
    assert.match(waitsForBackup(["cancel_driver_travel"], { driverHoldsGig: true, offeredTo: "Ida Ervanton" }) ?? "", /until Ida Ervanton accepts/)
  })

  it("offering the gig while the travel stays booked is fine", () => {
    assert.equal(waitsForBackup(["switch_driver", "message_driver"], holds), null)
  })

  it("changing the travel of a driver who keeps the gig is fine (the rail strike: cancel a train, book another)", () => {
    assert.equal(waitsForBackup(["cancel_driver_travel", "book_driver_travel", "book_hotel", "change_pickup_time"], holds), null)
  })

  it("a driver who cancelled the gig themselves is not waited for", () => {
    assert.equal(waitsForBackup(["republish_offer", "cancel_driver_travel"], { driverHoldsGig: false, offeredTo: null }), null)
  })

  it("the case file says who holds the gig and whether an offer is open", () => {
    const file = caseFile()
    assert.deepEqual(gigOf(file), { driverHoldsGig: true, offeredTo: null })
    assert.deepEqual(gigOf({ ...file, plan: { ...file.plan, handover: { to: "Ida Ervanton", at: null } } }), { driverHoldsGig: true, offeredTo: "Ida Ervanton" })
    assert.equal(gigOf({ ...file, order: { ...file.order, driver: { ...file.order.driver!, state: "cancelled" } } }).driverHoldsGig, false)
  })
})
