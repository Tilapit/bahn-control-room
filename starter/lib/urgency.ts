// What is lost next, and when. Code only (SPEC 6): the queue is sorted by this,
// and each card says it as a sentence. Never a score.

import type { CaseFile } from "./case"
import { clockZone, dayClockZone, dayRange, duration, minutesUntil } from "./time"

export type ConsequenceKind =
  | "ferry_cutoff" | "pickup_slot" | "pickup_running" | "pickup_missed" | "yard_release"
  | "delivery_promise" | "promise_missed" | "driver_travel" | "planned_pickup" | "alert_followup" | "no_deadline"

export type Urgency = {
  /** The moment something is lost. Null when the records hold no deadline. */
  at: string | null
  kind: ConsequenceKind
  /** One sentence for a person, against the simulated clock. */
  sentence: string
  /** "in 3 h", "1 h ago", "" when there is no deadline. */
  relative: string
  /** Missed already, or due within 4 hours. */
  timeRisk: boolean
  safety: boolean
}

type Candidate = { at: string; kind: ConsequenceKind; sentence: string }

const FERRY_SIGNALS = new Set(["FERRY_CONNECTION_RISK", "FERRY_SOLD_OUT", "FR_IMPORT_TRAVEL_DECISION"])
const DRIVER_SIGNALS = new Set(["DRIVER_AVAILABILITY_RISK", "POSITIONING_AT_RISK"])
const DRIVER_TASKS = new Set(["Decide on a backup driver", "Check the driver can reach the pickup"])
const TIME_RISK_MINUTES = 4 * 60

export function isSafety(file: CaseFile): boolean {
  return file.open.alerts.some((alert) => alert.severity === "critical" || alert.signal === "SAFETY_STOP")
    || file.open.incidents.some((incident) => incident.label.startsWith("warning light"))
}

export function urgency(file: CaseFile, now: Date): Urgency {
  const safety = isSafety(file)
  const { order } = file
  const upcoming: Candidate[] = []
  const missed: Candidate[] = []
  const later = (iso: string) => new Date(iso).getTime() > now.getTime()
  const done = order.stage.key === "delivered" || order.stage.key === "cancelled"

  // Ferry check-in on a booking that is at risk.
  const ferryAtRisk = file.open.alerts.some((alert) => FERRY_SIGNALS.has(alert.signal))
  for (const time of file.keyTimes) {
    if (time.key !== "ferry_cutoff" || !ferryAtRisk || done) continue
    if (later(time.start)) upcoming.push({ at: time.start, kind: "ferry_cutoff", sentence: `Ferry check-in${time.place ? ` in ${time.place}` : ""} closes at ${clockZone(time.start, time.zone)}` })
  }

  // Pickup slot for a car not yet collected (or a yard release slot after a transfer).
  for (const time of file.keyTimes) {
    if (time.key !== "pickup_slot" || done) continue
    const yard = time.label === "Yard release slot"
    const what = `${yard ? "Yard release" : "Pickup"}${time.place ? ` in ${time.place}` : ""}`
    const slot = `${yard ? "Yard release" : "Pickup"} slot${time.place ? ` in ${time.place}` : ""}`
    if (later(time.start)) {
      upcoming.push({ at: time.start, kind: yard ? "yard_release" : "pickup_slot", sentence: `${what} starts ${dayClockZone(time.start, now, time.zone)}` })
    } else if (time.end && later(time.end)) {
      upcoming.push({ at: time.end, kind: "pickup_running", sentence: `${slot} is open now, until ${clockZone(time.end, time.zone)}` })
    } else if (time.end) {
      missed.push({ at: time.end, kind: "pickup_missed", sentence: `${slot} ended at ${clockZone(time.end, time.zone)} and the car was not collected` })
    }
  }
  if (!done && !file.keyTimes.some((time) => time.key === "pickup_slot" || time.key === "picked_up")) {
    const planned = file.keyTimes.find((time) => time.key === "pickup_planned")
    if (planned && later(planned.start)) upcoming.push({
      at: planned.start, kind: "planned_pickup",
      sentence: `Planned pickup${planned.place ? ` in ${planned.place}` : ""}, ${dayRange(planned.start, planned.end, now, planned.zone)}, is not confirmed yet`,
    })
  }

  // Delivery promise for a car not yet delivered.
  const promise = file.keyTimes.find((time) => time.key === "delivery_promise" && time.label === "Delivery promise")
  if (promise && !done) {
    const end = promise.end ?? promise.start
    if (later(end)) upcoming.push({ at: end, kind: "delivery_promise", sentence: `Customer was promised delivery${promise.place ? ` in ${promise.place}` : ""} by ${dayClockZone(end, now, promise.zone)}` })
    else missed.push({ at: end, kind: "promise_missed", sentence: `Delivery promise${promise.place ? ` in ${promise.place}` : ""} ended at ${clockZone(end, promise.zone)} and the car has not arrived` })
  }

  // Booked driver travel, when the driver is the problem.
  const driverAtRisk = file.open.alerts.some((alert) => DRIVER_SIGNALS.has(alert.signal)) || file.open.tasks.some((task) => DRIVER_TASKS.has(task.label))
  if (driverAtRisk && !done) {
    for (const time of file.keyTimes) {
      if (time.key !== "driver_travel" || !later(time.start)) continue
      upcoming.push({ at: time.start, kind: "driver_travel", sentence: `${time.label}${time.place ? ` from ${time.place}` : ""} leaves at ${clockZone(time.start, time.zone)}` })
    }
  }

  const pick = (list: Candidate[]) => [...list].sort((a, b) => a.at.localeCompare(b.at))[0]
  const chosen = pick(missed) ?? pick(upcoming)
  if (chosen) return finish(chosen, now, safety)

  // No deadline in the records: fall back to the alert (SPEC 6), and say so.
  const alert = [...file.open.alerts].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0]
  if (alert) {
    const hours = alert.severity === "critical" || alert.severity === "high" ? 2 : 8
    const due = new Date(new Date(alert.at).getTime() + hours * 3600_000).toISOString()
    const age = duration(-(minutesUntil(alert.at, now) ?? 0))
    // Sorted by the alert's response time, but the sentence does not invent a deadline.
    if (later(due)) return { ...finish({ at: due, kind: "alert_followup", sentence: `No deadline in the records; alert open for ${age}` }, now, safety), relative: "", timeRisk: false }
    return { at: null, kind: "no_deadline", sentence: `No deadline in the records; open for ${age}`, relative: "", timeRisk: false, safety }
  }
  return { at: null, kind: "no_deadline", sentence: "No deadline in the records", relative: "", timeRisk: false, safety }
}

function finish(candidate: Candidate, now: Date, safety: boolean): Urgency {
  const minutes = minutesUntil(candidate.at, now) ?? 0
  return {
    at: candidate.at,
    kind: candidate.kind,
    sentence: candidate.sentence,
    relative: minutes >= 0 ? `in ${duration(minutes)}` : `${duration(minutes)} ago`,
    timeRisk: minutes < TIME_RISK_MINUTES,
    safety,
  }
}


function severityRank(severity: string): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity] ?? 4
}

/** Queue order (SPEC 6): safety first, then the earliest consequence; no deadline last. */
export function compareUrgency(a: Urgency, b: Urgency): number {
  if (a.safety !== b.safety) return a.safety ? -1 : 1
  if (a.at && b.at) return a.at.localeCompare(b.at)
  if (a.at) return -1
  if (b.at) return 1
  return 0
}
