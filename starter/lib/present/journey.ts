// "The car's journey": the order's milestones in plain words, built by code from the case file, with the point where
// the problem is. Confirmed means the records say it happened (or is booked); planned means it is not done yet.

import type { CaseFile } from "../case"
import type { Urgency } from "../urgency"

export type Milestone = { label: string; at: string | null; zone: string | null; note: string; state: "done" | "problem" | "planned" }

const PICKUP_KINDS = new Set(["pickup_slot", "pickup_running", "pickup_missed", "yard_release", "planned_pickup"])
const DELIVERY_KINDS = new Set(["delivery_promise", "promise_missed"])
const DRIVER_KINDS = new Set(["driver_travel", "offer_departs"])

export function journeyOf(file: CaseFile, urgency: Urgency, headline: string): Milestone[] {
  const { order, plan, keyTimes } = file
  const from = order.route.from
  const to = order.route.to
  const key = (name: string) => keyTimes.find((item) => item.key === name)
  const ferryProblem = urgency.kind === "ferry_cutoff" || /ferry|sailing|crossing/i.test(headline)
  const out: Milestone[] = [{ label: "Order created", at: order.createdAt, zone: from?.zone ?? null, note: "Order record", state: "done" }]

  // The driver: booked in the records, or still to find. A driver's own travel or a gig offer at risk is the problem point.
  const driverProblem = DRIVER_KINDS.has(urgency.kind) || /driver (may be ill|cancel|says doctor)|backup driver/i.test(headline)
  out.push(order.driver
    ? { label: "Driver booked", at: null, zone: null, note: order.driver.name, state: driverProblem ? "problem" : "done" }
    : { label: "Driver", at: null, zone: null, note: "Not booked yet", state: driverProblem ? "problem" : "planned" })

  const slot = key("pickup_slot") ?? key("pickup_planned")
  out.push(order.pickedUpAt
    ? { label: `Pickup ${from?.city ?? ""}`.trim(), at: order.pickedUpAt, zone: from?.zone ?? null, note: "Collected", state: "done" }
    : { label: `Pickup ${from?.city ?? ""}`.trim(), at: slot?.start ?? null, zone: slot?.zone ?? from?.zone ?? null, note: slot ? slot.label : "No slot in the records", state: PICKUP_KINDS.has(urgency.kind) || /pickup|not collected|release/i.test(headline) ? "problem" : "planned" })

  // A ferry crossing when the route has one: booked, or only quoted.
  if (order.route.ferry) {
    const booked = plan.bookings.find((booking) => booking.kind === "FERRY" && booking.state === "booked")
    const quote = plan.quotes.find((item) => item.kind === "FERRY")
    out.push({
      label: "Ferry", at: booked?.departureAt ?? key("ferry_cutoff")?.start ?? null, zone: booked?.zone ?? null,
      note: booked ? "Booked" : quote ? (quote.state === "sold out" ? "Sold out; quoted only" : "Quoted only, not booked") : "Not booked",
      state: ferryProblem ? "problem" : booked ? "done" : "planned",
    })
  }

  // On the road: only once the car is collected and not yet delivered; a safety stop is the problem point.
  if (order.pickedUpAt && !order.deliveredAt) {
    const position = plan.lastPosition
    out.push({ label: "On the road", at: position?.at ?? null, zone: to?.zone ?? null, note: position?.kmToGo != null ? `${position.kmToGo.toLocaleString("en-GB")} km to go at the last GPS` : "No GPS position", state: urgency.safety ? "problem" : "done" })
  }

  const promise = key("delivery_promise")
  out.push(order.deliveredAt
    ? { label: `Delivery ${to?.city ?? ""}`.trim(), at: order.deliveredAt, zone: to?.zone ?? null, note: "Delivered", state: "done" }
    : { label: `Delivery ${to?.city ?? ""}`.trim(), at: promise?.end ?? promise?.start ?? null, zone: promise?.zone ?? to?.zone ?? null, note: promise ? "Promised to the customer" : "No promise in the records", state: DELIVERY_KINDS.has(urgency.kind) || /delivery (today )?missed|late/i.test(headline) ? "problem" : "planned" })
  return out
}
