// The Executor (SPEC 7): code that carries out an approved option exactly, step by
// step, and records each effect as a timeline entry. Before writing it re-checks the
// current state (the dataset's own rule for proposals: RECHECK_CURRENT_STATE_BEFORE_WRITE):
// no second ferry booking, a sailing that is still free, a card still approved.
// Bookings are simulated: nothing real is bought.

import { createHash } from "node:crypto"
import { getCase, type CaseFile } from "./case"
import { now as clockNow } from "./clock"
import { describeFerry, ferryOptions } from "./agents/mocks"
import { writeEntry } from "./agents/entries"
import type { CardOption, CardStep, ExecutedEffect } from "./schema"
import { orderView } from "./queue"
import { at } from "./time"
import { money } from "./words"

type Lookup = { kind: string; label: string; price_cents: number | null; details: Record<string, unknown> }

const EXECUTOR = "Executor (approved by Ops)"

function reference(prefix: string, seed: string): string {
  return `${prefix}-${createHash("sha256").update(seed).digest("hex").slice(0, 6).toUpperCase()}`
}

const text = (value: unknown) => typeof value === "string" ? value.trim() : ""

function stepLookup(step: CardStep): Lookup | null {
  const lookup = step.params.lookup
  return lookup && typeof lookup === "object" ? lookup as Lookup : null
}

export async function execute(input: { decisionId: string; orderId: string; option: CardOption; actor: string }): Promise<ExecutedEffect> {
  const effect: ExecutedEffect = { ok: true, steps: [], bookings: [], windows: [] }
  const file = await getCase(input.orderId)
  if (!file) return { ...effect, ok: false, steps: [{ action: "load", ok: false, summary: "The order could not be loaded.", entryId: null, error: "order missing" }] }
  const steps = input.option.steps?.length ? input.option.steps : [{ action: input.option.action, params: input.option.params }]
  // A card for several orders: each step names the order it is for; the rest are for the card's own order.
  const files = new Map([[file.order.id, file]])
  const orderOf = (step: CardStep) => typeof step.params.order_id === "string" ? step.params.order_id : input.orderId
  for (const step of steps) {
    const orderId = orderOf(step)
    if (!files.has(orderId)) {
      const other = await getCase(orderId)
      if (!other) { effect.ok = false; effect.steps.push({ action: step.action, ok: false, summary: "The order could not be loaded.", entryId: null, error: "order missing", orderId }); break }
      files.set(orderId, other)
    }
    const result = await runStep(files.get(orderId)!, step, { ...input, orderId })
    effect.steps.push({ ...result.step, orderId })
    if (result.booking) effect.bookings.push({ ...result.booking, orderId })
    if (result.window) effect.windows.push({ ...result.window, orderId })
    // Stop at the first failure: the rest of an option assumes the earlier steps happened.
    if (!result.step.ok) { effect.ok = false; break }
  }
  if (files.size > 1) effect.orders = [...files.keys()]
  // An option that settles the situation (a booking, a moved crossing, a new driver, a tow, a changed time) closes the
  // signals it answered, on the order it settled. Calls, messages and notes do not: the situation is still open after them.
  if (effect.ok) {
    effect.handled = []
    for (const [orderId, target] of files) {
      if (!steps.some((step) => orderOf(step) === orderId && RESOLVES.has(step.action))) continue
      const { open } = target
      const handled = [
        ...open.alerts.map((alert) => ({ kind: "alert" as const, id: alert.id, label: `${alert.label.toLowerCase()} alert`, orderId })),
        ...open.incidents.map((incident) => ({ kind: "incident" as const, id: incident.id, label: `${incident.label} incident`, orderId })),
        ...open.proposals.map((proposal) => ({ kind: "proposal" as const, id: proposal.id, label: `earlier proposal: ${proposal.summary.replace(/\.$/, "").toLowerCase()}`, orderId })),
      ]
      effect.handled.push(...handled)
      if (handled.length) {
        await writeEntry({
          orderId, at: await clockNow(), source: "person", channel: "executor_close", authorType: "operator", authorLabel: EXECUTOR,
          kind: "event", status: "done", summary: `Closed by the approved decision: ${handled.map((item) => item.label).join("; ")}`,
          evidence: { table: "decisions", id: input.decisionId },
        })
      }
    }
  }
  return effect
}

const RESOLVES = new Set(["book_ferry", "change_ferry_booking", "switch_driver", "book_tow", "change_pickup_time", "change_delivery_time", "book_driver_travel"])

type StepResult = { step: ExecutedEffect["steps"][number]; booking?: ExecutedEffect["bookings"][number]; window?: ExecutedEffect["windows"][number] }

async function runStep(file: CaseFile, step: CardStep, input: { decisionId: string; orderId: string; actor: string }): Promise<StepResult> {
  const now = await clockNow()
  const zone = orderView(file).zone
  const lookup = stepLookup(step)
  const entry = (fields: Omit<Parameters<typeof writeEntry>[0], "orderId" | "at" | "evidence" | "authorLabel" | "authorType">) => writeEntry({
    orderId: input.orderId, at: now, authorType: "operator", authorLabel: EXECUTOR, evidence: { table: "decisions", id: input.decisionId }, ...fields,
  })
  const fail = (error: string): StepResult => ({ step: { action: step.action, ok: false, summary: `Not carried out: ${error}`, entryId: null, error } })

  switch (step.action) {
    case "book_ferry":
    case "change_ferry_booking": {
      if (!lookup) return fail("the sailing is missing from the approved option")
      const sailing = lookup.details as { departureAt?: string; checkInCutoffAt?: string; from?: string; priceCents?: number | null; provider?: string }
      // Re-check before writing: a second booking would hold two crossings for one car.
      const booked = file.plan.bookings.find((booking) => booking.kind === "Ferry" && booking.state === "booked")
      if (step.action === "book_ferry" && booked) return fail(`this car already has a booked crossing (${booked.summary})`)
      const fresh = await ferryOptions(input.orderId, new Date(new Date(String(sailing.departureAt)).getTime() - 60_000), now)
      const still = fresh.options.find((option) => option.departureAt === new Date(String(sailing.departureAt)).toISOString())
      if (!still || still.state === "sold out") return fail(`the ${at(sailing.departureAt, "Europe/Berlin")} sailing has no vehicle space any more`)
      const ref = reference("VCL", `${input.orderId}|${still.departureAt}`)
      const summary = `${step.action === "change_ferry_booking" ? "Ferry booking moved" : "Ferry booked"}: ${describeFerry({ ...still, state: "booked for this car" }).replace(/ \(booked for this car\)$/, "")}, booking ${ref} (simulated)`
      const entryId = await entry({ source: "booking", channel: "executor_booking", kind: "booking", status: "booked", summary, body: `Booked by the Executor after Ops approved it. Re-checked first: no other booking for this car, vehicle space still free. A booking does not prove check-in or boarding.` })
      return {
        step: { action: step.action, ok: true, summary, entryId },
        booking: { kind: "Ferry", summary, departureAt: still.departureAt, cutoffAt: still.checkInCutoffAt, zone: "Europe/Berlin", entryId, reference: ref, priceCents: still.priceCents },
      }
    }
    case "book_hotel":
    case "book_driver_travel": {
      if (!lookup) return fail("the option is missing from the approved card")
      // A proposal can wait on For you longer than its train: never book a departure that has gone.
      const leaves = (lookup.details as { departureAt?: string } | undefined)?.departureAt
      if (step.action === "book_driver_travel" && leaves && new Date(leaves).getTime() <= now.getTime()) return fail(`the ${lookup.label} has already left`)
      const ref = reference(step.action === "book_hotel" ? "HTL" : "TRV", `${input.orderId}|${lookup.label}`)
      const kind = step.action === "book_hotel" ? "Hotel" : String((lookup.details as { kind?: string }).kind ?? "Train").replace(/^./, (c) => c.toUpperCase())
      const summary = `${kind} booked for the driver: ${lookup.label}${lookup.price_cents ? `, ${money(lookup.price_cents, "EUR")}` : ""}, booking ${ref} (simulated)`
      const entryId = await entry({ source: "booking", channel: "executor_booking", kind: "booking", status: "booked", summary, body: "Booked by the Executor after Ops approved it. A booking does not prove the driver travelled or stayed." })
      const details = lookup.details as { departureAt?: string; checkIn?: string }
      return { step: { action: step.action, ok: true, summary, entryId }, booking: { kind, summary, departureAt: details.departureAt ?? details.checkIn ?? null, cutoffAt: null, zone, entryId, reference: ref, priceCents: lookup.price_cents } }
    }
    case "cancel_driver_travel": {
      const summary = `Cancelled for the driver: ${text(step.params.text) || text(step.params.what) || "booked travel"} (simulated; refund terms not known)`
      return { step: { action: step.action, ok: true, summary, entryId: await entry({ source: "booking", channel: "executor_cancel", kind: "event", status: "superseded", summary }) } }
    }
    case "switch_driver": {
      const name = text(step.params.name) || lookup?.label || "the backup driver"
      const summary = `Gig offered to ${name} directly; the current driver stays booked until ${name} accepts (simulated offer)`
      return { step: { action: step.action, ok: true, summary, entryId: await entry({ source: "person", channel: "executor_offer", kind: "event", summary }) } }
    }
    case "republish_offer":
    case "raise_fee": {
      const summary = step.action === "raise_fee" ? `Driver fee raised by €${Number(step.params.amount_eur ?? 0)} (simulated)` : "Gig offered to drivers again (simulated)"
      return { step: { action: step.action, ok: true, summary, entryId: await entry({ source: "person", channel: "executor_offer", kind: "event", summary }) } }
    }
    case "change_pickup_time":
    case "change_delivery_time": {
      const start = text(step.params.start)
      if (!start || Number.isNaN(new Date(start).getTime())) return fail("the new time is missing")
      const end = text(step.params.end) || null
      const key = step.action === "change_pickup_time" ? "pickup_slot" as const : "delivery_promise" as const
      const place = key === "pickup_slot" ? file.order.route.from : file.order.route.to
      const placeZone = place?.zone ?? zone
      const where = text(step.params.text)
      const summary = `${key === "pickup_slot" ? "Pickup" : "Delivery"} time changed to ${at(start, placeZone)}${end ? `–${at(end, placeZone).split(" ").slice(3).join(" ")}` : ""}${where ? `, ${where}` : ""}`
      const entryId = await entry({ source: "person", channel: "executor_window", kind: "event", status: "done", summary })
      return { step: { action: step.action, ok: true, summary, entryId }, window: { key, start: new Date(start).toISOString(), end: end ? new Date(end).toISOString() : null, zone: placeZone, place: where || place?.city || null, entryId } }
    }
    case "book_tow":
    case "approve_repair_cost": {
      const name = lookup?.label ?? "the workshop"
      const details = lookup?.details as { towToShopCents?: number; towToDeliveryCents?: number | null } | undefined
      const price = step.action === "approve_repair_cost" ? Math.round(Number(step.params.amount_eur ?? 0) * 100) : text(step.params.to) === "delivery" ? details?.towToDeliveryCents ?? null : details?.towToShopCents ?? null
      const summary = step.action === "book_tow" ? `Tow booked: ${name}, to the ${text(step.params.to) === "delivery" ? "delivery address" : "workshop"}${price ? `, about ${money(price, "EUR")}` : ""} (simulated)` : `Repair cost agreed with ${name}: ${money(price, "EUR")}`
      return { step: { action: step.action, ok: true, summary, entryId: await entry({ source: "booking", channel: "executor_booking", kind: "booking", status: "booked", summary }) } }
    }
    case "message_customer": {
      const body = text(step.params.text)
      if (!body) return fail("the email has no text")
      const to = text(step.params.to) || file.order.customer.name
      const summary = `Email to ${to}, approved by ${input.actor}: ${body.length > 160 ? `${body.slice(0, 159)}…` : body}`
      return { step: { action: step.action, ok: true, summary: `Emailed ${to}`, entryId: await entry({ source: "email", channel: "customer_email", kind: "message", summary, body, visibility: "public" }) } }
    }
    case "call_customer":
    case "call_contact": {
      const to = text(step.params.to) || (step.action === "call_customer" ? file.order.customer.name : "the contact")
      const summary = `${input.actor} calls ${to}: ${text(step.params.text) || "about this order"}`
      return { step: { action: step.action, ok: true, summary: `Call to ${to} handed to ${input.actor}`, entryId: await entry({ source: "person", channel: "executor_call", kind: "event", summary }) } }
    }
    case "message_driver": {
      const body = text(step.params.text)
      if (!body) return fail("the message has no text")
      return { step: { action: step.action, ok: true, summary: "Messaged the driver", entryId: await writeEntry({ orderId: input.orderId, at: now, source: "driver_chat", channel: "driver_chat", authorType: "operator", authorLabel: "Ops", kind: "message", summary: body, body, visibility: "public", evidence: { table: "decisions", id: input.decisionId } }) } }
    }
    case "note": {
      const minutes = Number(step.params.minutes ?? step.params.check_again_minutes ?? 0)
      const summary = `Plan kept as it is${minutes ? `; the agent checks again at ${at(new Date(now.getTime() + minutes * 60_000), zone)}` : ""}${text(step.params.text) ? `. ${text(step.params.text)}` : ""}`
      return { step: { action: step.action, ok: true, summary, entryId: await entry({ source: "person", channel: "executor_note", kind: "event", status: "done", summary }) } }
    }
    default:
      return fail(`"${step.action}" is not something the Executor can do`)
  }
}
