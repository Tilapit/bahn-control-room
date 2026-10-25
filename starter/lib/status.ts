// The one-line status at the top of an order: what is wrong (or where the car
// is), then what is lost next. Built by code from the case file.

import type { CaseFile } from "./case"
import { dayAndClock, dayClockZone, duration, minutesUntil } from "./time"
import type { Urgency } from "./urgency"

/** Who has an order, for the Orders list: a person (a card waits, or Ops took it over), an agent, or nobody is needed. */
export type Holder = "you" | "agent" | "nobody"

/** "ferry sold out" from a card headline ("BMW M4: ferry sold out; 14:00 sailing still free") or a live signal. */
const OPS_START = /^(driver|car|ferry|pickup|delivery|customer|train|flight|hotel|site|order|gig|backup|photos?|proof|invoice|agent|rail|protest|strike|warning|empty|no|not|the|a|an)\b/i

export function problemPhrase(text: string | null | undefined): string | null {
  if (!text) return null
  const whole = text.replace(/^\d+ orders:\s*/, "").replace(/^[^:]{2,60}:\s*(?=\S)/, "").replace(/^(open|taken) (alert|task|incident):\s*/, "").trim()
  // The part before the first ";" is the problem; a one-word part ("delivered") keeps what follows it.
  const first = whole.split(/;\s/)[0]
  const plain = first.length < 16 ? whole : first
  if (!plain) return null
  const short = plain.length > 72 ? `${plain.slice(0, 72).replace(/\s+\S*$/, "")}…` : plain
  // A person's name or an acronym keeps its capitals ("Ida Ervanton took the gig", "CMR missing"); an ops word starts
  // lower case ("driver Carl says").
  if ((!OPS_START.test(short) && /^\p{Lu}\p{Ll}+\s+\p{Lu}/u.test(short)) || /^\p{Lu}{2,}\b/u.test(short)) return short
  return short.charAt(0).toLowerCase() + short.slice(1)
}

/**
 * One plain sentence per order for the Orders list: "Waiting for you: ferry sold out", "Agent working: driver may be
 * ill", "Moving, 233 km to go", "Delivered Tue 20 Oct". Built by code from the case file and who has the order.
 */
export function listStatus(file: CaseFile, state: { holder: Holder; problem: string | null; takenOver: boolean }, now: Date): string {
  const { order, plan } = file
  if (state.takenOver) return `Taken over by Ops${state.problem ? `: ${state.problem}` : ""}`
  if (state.holder === "you") return `Waiting for you${state.problem ? `: ${state.problem}` : ""}`
  if (state.holder === "agent") return `Agent working${state.problem ? `: ${state.problem}` : ""}`
  switch (order.stage.key) {
    case "moving": return plan.lastPosition?.kmToGo != null ? `Moving, ${plan.lastPosition.kmToGo.toLocaleString("en-GB")} km to go` : "Moving, no GPS position yet"
    case "delivered": {
      const day = order.deliveredAt ? dayAndClock(order.deliveredAt, now, order.route.to?.zone) : ""
      return day ? `Delivered ${day.slice(0, day.lastIndexOf(" "))}` : "Delivered"
    }
    case "cancelled": return "Cancelled"
    case "at_transfer": return `At the transfer yard${order.route.via?.city ? ` in ${order.route.via.city}` : ""}`
    case "driver_booked": {
      const pickup = file.keyTimes.find((item) => item.key === "pickup_slot")
      return `Driver booked${pickup ? `, pickup ${dayClockZone(pickup.start, now, pickup.zone)}` : ""}`
    }
    case "finding_driver": return "Offered to drivers, not taken yet"
    case "ready": return "Not offered to drivers yet"
    default: return "New, being prepared"
  }
}

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
