// The one-line status at the top of an order: what is wrong (or where the car
// is), then what is lost next. Built by code from the case file.

import type { CaseFile } from "./case"
import { dayAndClock, duration, minutesUntil } from "./time"
import type { Urgency } from "./urgency"

function stagePhrase(file: CaseFile, now: Date): string {
  const { order, plan } = file
  const from = order.route.from?.city ?? "the pickup"
  const to = order.route.to?.city ?? "the delivery address"
  switch (order.stage.key) {
    case "cancelled": return "Cancelled"
    case "delivered": return order.deliveredAt ? `Delivered ${dayAndClock(order.deliveredAt, now, order.route.to?.zone)} in ${to}` : "Delivered"
    case "at_transfer": return `Waiting at the transfer yard in ${order.route.via?.city ?? "the yard"}`
    case "moving": {
      const last = plan.lastPosition
      if (!last) return `On the road from ${from} to ${to}; no driver-app position yet`
      const age = duration(-(minutesUntil(last.at, now) ?? 0))
      return `On the road from ${from} to ${to}, ${last.kmToGo ?? "?"} km to go at the last position (${age} old)`
    }
    case "driver_booked": return `${order.driver?.name ?? "A driver"} is booked to collect it in ${from}`
    case "finding_driver": return `Offered to drivers; nobody has taken the gig yet`
    case "ready": return "Not offered to drivers yet"
    default: return "New order, still being prepared"
  }
}

export function statusLine(file: CaseFile, urgency: Urgency, now: Date, issue: string | null): string {
  const first = issue ? issue.charAt(0).toUpperCase() + issue.slice(1) : stagePhrase(file, now)
  const nothingOpen = !issue && urgency.kind === "no_deadline"
  // The sentence holds the clock time with its zone; the distance from now follows it once.
  const second = nothingOpen ? (file.order.stage.key === "delivered" || file.order.stage.key === "cancelled" ? "Nothing open." : null)
    : urgency.relative ? `${urgency.sentence}, ${urgency.relative}` : urgency.sentence
  return [first, second].filter(Boolean).map((part) => part!.replace(/\.$/, "")).join(". ") + "."
}
