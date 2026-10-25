// Urgency (SPEC 6): what is lost next, the sentence a person reads, and the queue order. Code only, no database.

import "./setup"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { dayRange } from "@/lib/time"
import { compareUrgency, urgency, withProposalDeadline } from "@/lib/urgency"
import { alert, caseFile, hoursFromNow, keyTime, NOW } from "./helpers"

describe("urgency: what is lost next", () => {
  it("a pickup slot that ended without a collection is already missed, and wins over anything still ahead", () => {
    const file = caseFile({ keyTimes: [
      keyTime("pickup_slot", hoursFromNow(-4), { end: hoursFromNow(-2), place: "Helsinki", zone: "Europe/Helsinki" }),
      keyTime("delivery_promise", hoursFromNow(1), { end: hoursFromNow(2) }),
    ] })
    const u = urgency(file, NOW)
    assert.equal(u.kind, "pickup_missed")
    assert.equal(u.sentence, "Pickup slot in Helsinki ended at 10:00 EEST and the car was not collected")
    assert.equal(u.relative, "2 h ago")
    assert.equal(u.timeRisk, true)
  })

  it("a delivery promise that ended without a delivery is missed", () => {
    const file = caseFile({ stage: "moving", keyTimes: [keyTime("delivery_promise", hoursFromNow(-5), { end: hoursFromNow(-1) })] })
    const u = urgency(file, NOW)
    assert.equal(u.kind, "promise_missed")
    assert.equal(u.sentence, "Delivery promise in Hamburg ended at 10:00 CEST and the car has not arrived")
    assert.equal(u.relative, "1 h ago")
  })

  it("a ferry check-in counts only while a ferry alert is open, and the sentence names the place and the local time", () => {
    const cutoff = keyTime("ferry_cutoff", hoursFromNow(3))
    const quiet = urgency(caseFile({ stage: "moving", keyTimes: [cutoff] }), NOW)
    assert.notEqual(quiet.kind, "ferry_cutoff")
    const atRisk = urgency(caseFile({ stage: "moving", keyTimes: [cutoff], alerts: [alert("FERRY_CONNECTION_RISK", "high", hoursFromNow(-1))] }), NOW)
    assert.equal(atRisk.kind, "ferry_cutoff")
    // 12:00 UTC is 14:00 in Hamburg (CEST).
    // The clock time carries its zone, and the distance from now is said once, in `relative`, not twice.
    assert.equal(atRisk.sentence, "Ferry check-in in Hamburg closes at 14:00 CEST")
    assert.equal(atRisk.relative, "in 3 h")
    assert.equal(atRisk.timeRisk, true)
  })

  it("with no booking, only quotes, the pickup slot is the next consequence (CD-420299)", () => {
    const file = caseFile({ keyTimes: [keyTime("pickup_slot", hoursFromNow(50), { end: hoursFromNow(52), place: "Leipzig" }), keyTime("delivery_promise", hoursFromNow(150), { end: hoursFromNow(152) })], alerts: [alert("FERRY_SOLD_OUT", "high", hoursFromNow(-2))] })
    const u = urgency(file, NOW)
    assert.equal(u.kind, "pickup_slot")
    assert.match(u.sentence, /^Pickup in Leipzig starts Fri 23 Oct/)
    assert.equal(u.timeRisk, false)
  })

  it("booked driver travel counts only when the driver is the problem (CD-420449)", () => {
    const train = keyTime("driver_travel", hoursFromNow(1.5), { label: "Driver's train", place: "Aalborg", zone: "Europe/Copenhagen" })
    const promise = keyTime("delivery_promise", hoursFromNow(30), { end: hoursFromNow(32) })
    assert.equal(urgency(caseFile({ keyTimes: [train, promise] }), NOW).kind, "delivery_promise")
    const ill = urgency(caseFile({ keyTimes: [train, promise], alerts: [alert("DRIVER_AVAILABILITY_RISK", "high", hoursFromNow(-1))] }), NOW)
    assert.equal(ill.kind, "driver_travel")
    assert.equal(ill.sentence, "Driver's train from Aalborg leaves at 12:30 CEST")
    assert.equal(ill.relative, "in 1 h 30 min")
  })

  it("an intake order with only a proposed pickup says it is not confirmed", () => {
    const u = urgency(caseFile({ stage: "intake", keyTimes: [keyTime("pickup_planned", hoursFromNow(120), { place: "Hamburg" })] }), NOW)
    assert.equal(u.kind, "planned_pickup")
    assert.equal(u.sentence, "Planned pickup in Hamburg, Mon 26 Oct 10:00 CET, is not confirmed yet")
  })

  it("without a deadline in the records, a fresh alert sorts by its response time but the sentence invents no deadline", () => {
    const u = urgency(caseFile({ alerts: [alert("TRACKING_GAP", "high", hoursFromNow(-1))] }), NOW)
    assert.equal(u.kind, "alert_followup")
    assert.equal(u.at, hoursFromNow(1))
    assert.equal(u.sentence, "No deadline in the records; alert open for 1 h")
    assert.equal(u.relative, "")
    assert.equal(u.timeRisk, false)
  })

  it("a stale alert has no deadline at all (CD-420164 must not outrank a ferry closing in 3 hours)", () => {
    const stale = urgency(caseFile({ alerts: [alert("MISSING_SIGNATURE", "medium", hoursFromNow(-48))] }), NOW)
    assert.equal(stale.at, null)
    assert.equal(stale.kind, "no_deadline")
    const ferry = urgency(caseFile({ stage: "moving", keyTimes: [keyTime("ferry_cutoff", hoursFromNow(3))], alerts: [alert("FERRY_CONNECTION_RISK", "high", hoursFromNow(-1))] }), NOW)
    assert.ok(compareUrgency(ferry, stale) < 0)
  })

  it("time risk means missed, or due within 4 hours", () => {
    const due = (hours: number) => urgency(caseFile({ keyTimes: [keyTime("pickup_slot", hoursFromNow(hours), { end: hoursFromNow(hours + 2) })] }), NOW)
    assert.equal(due(3.9).timeRisk, true)
    assert.equal(due(4.1).timeRisk, false)
  })

  it("delivered and cancelled orders lose nothing", () => {
    for (const stage of ["delivered", "cancelled"] as const) {
      const u = urgency(caseFile({ stage, keyTimes: [keyTime("pickup_slot", hoursFromNow(-5), { end: hoursFromNow(-3) }), keyTime("delivery_promise", hoursFromNow(-2), { end: hoursFromNow(-1) })] }), NOW)
      assert.equal(u.kind, "no_deadline")
      assert.equal(u.at, null)
    }
  })
})

describe("urgency: the For you order", () => {
  it("safety first, then the earliest consequence, no deadline last", () => {
    const safety = urgency(caseFile({ stage: "moving", alerts: [alert("SAFETY_STOP", "critical", hoursFromNow(-0.5))], keyTimes: [keyTime("delivery_promise", hoursFromNow(20), { end: hoursFromNow(22) })] }), NOW)
    const missed = urgency(caseFile({ keyTimes: [keyTime("pickup_slot", hoursFromNow(-4), { end: hoursFromNow(-2) })] }), NOW)
    const soon = urgency(caseFile({ keyTimes: [keyTime("pickup_slot", hoursFromNow(2), { end: hoursFromNow(4) })] }), NOW)
    const later = urgency(caseFile({ keyTimes: [keyTime("pickup_slot", hoursFromNow(30), { end: hoursFromNow(32) })] }), NOW)
    const none = urgency(caseFile({ alerts: [alert("MISSING_SIGNATURE", "medium", hoursFromNow(-48))] }), NOW)
    assert.equal(safety.safety, true)
    const sorted = [none, later, soon, safety, missed].sort(compareUrgency)
    assert.deepEqual(sorted, [safety, missed, soon, later, none])
  })

  it("a warning-light incident counts as safety even before an alert is raised", () => {
    const file = caseFile({ stage: "moving", incidents: [{ id: "inc-1", label: "warning light on the road", status: "open", owner: null, notes: null, source: { entryId: null, label: "", chip: "", at: null } }] })
    assert.equal(urgency(file, NOW).safety, true)
  })
})

describe("urgency: a proposal's own deadline", () => {
  it("a proposed train that leaves before the order's deadline sorts the card by that departure", () => {
    const u = urgency(caseFile({ stage: "driver_booked", keyTimes: [keyTime("pickup_slot", hoursFromNow(25), { place: "Marseille", zone: "Europe/Paris" })] }), NOW)
    const option = { id: "opt-1", label: "Book the train", action: "book_driver_travel", params: {}, kind: "approve" as const, steps: [
      { action: "book_driver_travel", params: { lookup: { label: "train Bordeaux to Marseille", details: { departureAt: hoursFromNow(1.25), from: "Marseille", kind: "train" } } } },
    ] }
    const sooner = withProposalDeadline(u, option, NOW)
    assert.equal(sooner.kind, "offer_departs")
    assert.equal(sooner.sentence, "The train this proposal books from Marseille leaves at 12:15 CEST")
    assert.equal(sooner.timeRisk, true)
    assert.equal(compareUrgency(sooner, u), -1)
  })

  it("a departure that has already gone, or that comes after the order's deadline, changes nothing", () => {
    const u = urgency(caseFile({ stage: "driver_booked", keyTimes: [keyTime("pickup_slot", hoursFromNow(2), { place: "Lyon", zone: "Europe/Paris" })] }), NOW)
    const later = { id: "o", label: "x", action: "book_driver_travel", params: {}, steps: [{ action: "book_driver_travel", params: { lookup: { details: { departureAt: hoursFromNow(5), from: "Lyon" } } } }] }
    const gone = { id: "o", label: "x", action: "book_driver_travel", params: {}, steps: [{ action: "book_driver_travel", params: { lookup: { details: { departureAt: hoursFromNow(-1), from: "Lyon" } } } }] }
    assert.deepEqual(withProposalDeadline(u, later, NOW), u)
    assert.deepEqual(withProposalDeadline(u, gone, NOW), u)
  })
})

describe("time: a window is shown as a window", () => {
  it("prints both ends and the zone, never only the start (a 10:00–16:00 promise is not late at 12:48)", () => {
    assert.equal(dayRange("2026-10-21T07:00:00Z", "2026-10-21T13:00:00Z", NOW, "Europe/Helsinki"), "today 10:00–16:00 EEST")
    assert.equal(dayRange("2026-10-23T10:00:00Z", "2026-10-23T12:00:00Z", NOW, "Europe/Helsinki"), "Fri 23 Oct 13:00–15:00 EEST")
  })
})
