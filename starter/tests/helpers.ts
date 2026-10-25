// A small case file for unit tests: an order in Lahti → Hamburg with nothing open, at the snapshot time.
// Each test sets only what it is about (a key time, an alert, a task).

import type { CaseFile, CasePlace, KeyTime, SourceRef, StageKey } from "@/lib/case"

export const NOW = new Date("2026-10-21T09:00:00Z")
export const SOURCE: SourceRef = { entryId: null, label: "Order record", chip: "Order record", at: null }

const place = (city: string, zone: string): CasePlace => ({ name: `${city} dealer`, city, country: "XX", zone, kind: "dealer", addressLine: null })

export const hoursFromNow = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString()

export function keyTime(key: KeyTime["key"], start: string, extra: Partial<KeyTime> = {}): KeyTime {
  return { key, label: key === "pickup_slot" ? "Pickup slot" : key === "delivery_promise" ? "Delivery promise" : key === "ferry_cutoff" ? "Ferry check-in closes" : key, start, end: null, zone: "Europe/Berlin", place: "Hamburg", note: null, source: SOURCE, ...extra }
}

export function alert(signal: string, severity: string, at: string, taken = false): CaseFile["open"]["alerts"][number] {
  return { id: `alert-${signal}`, signal, label: signal.toLowerCase().replaceAll("_", " "), severity, taken, owner: null, summary: "", at, conversationId: null, source: SOURCE }
}

export function caseFile(patch: { stage?: StageKey; keyTimes?: KeyTime[]; alerts?: CaseFile["open"]["alerts"]; tasks?: CaseFile["open"]["tasks"]; incidents?: CaseFile["open"]["incidents"] } = {}): CaseFile {
  const stage = patch.stage ?? "driver_booked"
  return {
    asOf: NOW.toISOString(),
    order: {
      id: "ord-test", reference: "CD-499999", customerReference: null, synthetic: null, stage: { key: stage, label: stage },
      customer: { id: "cus-test", name: "Test Motors", tier: null },
      car: { make: "Volvo", model: "V60", year: 2024, registration: null, vin: null, fuel: null, label: "Volvo V60", image: null },
      tradeIn: null,
      route: { from: place("Lahti", "Europe/Helsinki"), to: place("Hamburg", "Europe/Berlin"), via: null, kind: "import", distanceKm: 1500, ferry: true },
      driver: { id: "drv-test", name: "Test Driver", home: null, state: "booked" }, otherDrivers: [],
      createdAt: "2026-10-15T08:00:00Z", pickedUpAt: null, deliveredAt: stage === "delivered" ? "2026-10-20T10:00:00Z" : null, cancelledAt: stage === "cancelled" ? "2026-10-20T10:00:00Z" : null,
    },
    keyTimes: patch.keyTimes ?? [],
    facts: [],
    open: { alerts: patch.alerts ?? [], tasks: patch.tasks ?? [], incidents: patch.incidents ?? [], cards: [], proposals: [], claims: [], conversations: [], supportInbox: [], documents: [] },
    plan: { stops: [], legs: [], offer: null, bookings: [], quotes: [], lastPosition: null, positions: [], terminalDrive: null, handover: null },
    timeline: [],
  }
}
