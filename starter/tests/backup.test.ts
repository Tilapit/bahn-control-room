// Scenario 4's last step and the hand-back (lib/policies.ts, lib/takeover.ts): the replaced driver's travel can be
// cancelled only after the backup's yes, and a hand-back reads exactly the messages that came in during the takeover.

import "./setup"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { gigHolder, waitsForBackup } from "@/lib/policies"
import { missedDuringTakeover, type HandBackCandidate } from "@/lib/takeover"

const offer = { to: "Ida Ervanton", replacing: "drv-434", at: "2026-10-21T10:00:00.000Z" }

describe("a backup driver accepts the gig", () => {
  it("before the yes, the offer is open and cancelling the current driver's travel is refused", () => {
    const holder = gigHolder({ driverId: "drv-434", offers: [offer], acceptances: [] })
    assert.equal(holder.driverId, "drv-434")
    assert.deepEqual(holder.open, { to: "Ida Ervanton", at: offer.at })
    assert.match(waitsForBackup(["cancel_driver_travel"], { driverHoldsGig: true, offeredTo: holder.open?.to ?? null }) ?? "", /Ida Ervanton accepts/)
  })

  it("after the yes, the backup holds the gig, the offer is answered and the cancellation is allowed", () => {
    const holder = gigHolder({ driverId: "drv-434", offers: [offer], acceptances: [{ by: "Ida Ervanton", at: "2026-10-21T10:20:00.000Z" }] })
    assert.equal(holder.acceptedBy, "Ida Ervanton")
    assert.equal(holder.open, null)
    assert.equal(waitsForBackup(["cancel_driver_travel"], { driverHoldsGig: true, offeredTo: holder.open }), null)
  })

  it("a yes from someone else, or from before the offer went out, answers nothing", () => {
    for (const acceptances of [[{ by: "Milo Briarmont", at: "2026-10-21T10:20:00.000Z" }], [{ by: "Ida Ervanton", at: "2026-10-21T09:30:00.000Z" }]]) {
      const holder = gigHolder({ driverId: "drv-434", offers: [offer], acceptances })
      assert.equal(holder.acceptedBy, null)
      assert.equal(holder.open?.to, "Ida Ervanton")
    }
  })
})

describe("hand back reads what came in during the takeover", () => {
  const takenAt = new Date("2026-10-21T10:00:00Z")
  const handedBackAt = new Date("2026-10-21T10:40:00Z")
  const entry = (id: string, minute: number, patch: Partial<HandBackCandidate> = {}): HandBackCandidate => ({
    id, orderId: "ord-1", kind: "message", authorType: "driver",
    occurredAt: new Date(takenAt.getTime() + minute * 60_000), receivedAt: new Date(takenAt.getTime() + minute * 60_000), ...patch,
  })

  it("picks exactly the inbound, unread messages received in the window, oldest first", () => {
    const entries = [
      entry("before", -5),
      entry("driver-late", 30),
      entry("driver-early", 5),
      entry("customer", 12, { authorType: "customer" }),
      entry("ops-wrote", 15, { authorType: "operator" }),
      entry("agent-wrote", 16, { authorType: "agent" }),
      entry("a-gps-fix", 18, { kind: "position" }),
      entry("other-order", 20, { orderId: "ord-2" }),
      entry("already-read", 22),
      entry("after", 45),
      // Written earlier, arrived during the takeover: received time decides.
      entry("late-upload", 25, { occurredAt: new Date(takenAt.getTime() - 60 * 60_000) }),
    ]
    assert.deepEqual(missedDuringTakeover(entries, { orderId: "ord-1", takenAt, handedBackAt }, new Set(["already-read"])),
      ["driver-early", "customer", "late-upload", "driver-late"])
  })

  it("is idempotent: once read, a message is not picked again", () => {
    const entries = [entry("driver-early", 5)]
    assert.deepEqual(missedDuringTakeover(entries, { orderId: "ord-1", takenAt, handedBackAt }, new Set(["driver-early"])), [])
  })
})
