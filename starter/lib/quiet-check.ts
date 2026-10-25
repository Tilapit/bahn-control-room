// Quiet checks (SPEC 4): an order with no live signal is checked by code only, no
// model. The check is recorded as a run so the Agents view can show it ("Quiet
// checks"), with a sentence built from the case file and the next time worth a look.

import type { CaseFile } from "./case"
import { addStep, createRun, updateRun } from "./agents/runs"
import { orderView } from "./queue"
import { liveSignals } from "./signals"
import { dayClockZone, dayRange, relative } from "./time"

export const QUIET_AGENT = "Quiet check"
const HOUR = 3_600_000

function sentence(file: CaseFile, now: Date): string {
  const { order, plan } = file
  const from = order.route.from
  const to = order.route.to
  const time = (key: string) => file.keyTimes.find((item) => item.key === key)
  const promise = time("delivery_promise")
  const pickup = time("pickup_slot") ?? time("pickup_planned")
  switch (order.stage.key) {
    case "delivered":
      return `Nothing open. Delivered${order.deliveredAt ? ` ${dayClockZone(order.deliveredAt, now, to?.zone)}` : ""}${to?.city ? ` in ${to.city}` : ""}.`
    case "cancelled":
      return `Nothing open. The order was cancelled${order.cancelledAt ? ` ${dayClockZone(order.cancelledAt, now, from?.zone)}` : ""}.`
    case "moving": {
      const gps = plan.lastPosition
      const parts = [`On the road to ${to?.city ?? "the delivery address"}`]
      if (gps) parts.push(`last GPS ${relative(gps.at, now)}${gps.kmToGo != null ? `, ${gps.kmToGo} km to go` : ""}`)
      if (promise) parts.push(`delivery promised ${dayRange(promise.start, promise.end, now, promise.zone)}${promise.place ? ` in ${promise.place}` : ""}`)
      return `Nothing open. ${parts.join("; ")}.`
    }
    case "at_transfer":
      return `Nothing open. At the transfer yard${order.route.via?.city ? ` in ${order.route.via.city}` : ""}${promise ? `; delivery promised ${dayRange(promise.start, promise.end, now, promise.zone)}` : ""}.`
    default:
      return `Nothing open. ${order.stage.label}${pickup ? `; pickup ${pickup.key === "pickup_slot" ? "" : "planned "}${dayRange(pickup.start, pickup.end, now, pickup.zone)}${pickup.place ? ` in ${pickup.place}` : ""}` : ""}.`
  }
}

/** The quiet line for a list: "Nothing open. Delivery promised today 10:00–16:00 EEST in Tampere." */
export function quietLine(file: CaseFile, now: Date): string {
  return sentence(file, now)
}

/** When to look again: an hour before the next key time, at most four hours out. Finished orders need no check. */
function nextCheck(file: CaseFile, now: Date): Date | null {
  if (file.order.stage.key === "delivered" || file.order.stage.key === "cancelled") return null
  const upcoming = file.keyTimes.map((item) => new Date(item.start).getTime() - HOUR).filter((ms) => ms > now.getTime())
  return new Date(Math.min(now.getTime() + 4 * HOUR, ...upcoming))
}

export const QUIET_TRIGGER = "Routine check by code: no live signal on this order"
export const QUIET_STEP = "Checked alerts, tasks, incidents, handover claims, earlier agent proposals, the support inbox and conversations: nothing open."

/** What a quiet check records for an order: its one sentence, when to look again, and the step's input and output. */
export function quietOutcome(file: CaseFile, now: Date) {
  return {
    line: sentence(file, now), nextCheckAt: nextCheck(file, now),
    input: { zone: orderView(file).zone },
    output: { stage: file.order.stage.key, keyTimes: file.keyTimes.map((item) => ({ key: item.key, start: item.start })) },
  }
}

/** Record a quiet check for an order without live signals. Returns null when the order has one (it needs an agent). */
export async function quietCheck(file: CaseFile, now: Date): Promise<string | null> {
  if (liveSignals(file).length) return null
  const outcome = quietOutcome(file, now)
  const runId = await createRun({ orderId: file.order.id, agent: QUIET_AGENT, model: null, trigger: QUIET_TRIGGER, at: now })
  await addStep(runId, 0, { at: now, type: "tool_result", tool: "quiet_check", input: outcome.input, output: outcome.output, summary: QUIET_STEP })
  await updateRun(runId, { status: "done", finishedAt: now, outcomeSummary: outcome.line, narration: outcome.line, nextCheckAt: outcome.nextCheckAt })
  return runId
}
