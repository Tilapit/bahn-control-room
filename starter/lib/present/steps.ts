// What an approved option does, in plain words built by code from its steps (not
// from the agent's label), so a card says exactly who does what before anyone
// presses the button: "you call Marvellin Motorhandel, the driver gets a message".

import type { CardOption, CardStep } from "../schema"
import { range } from "../time"

type Lookup = { label?: string; price_cents?: number | null }

const str = (value: unknown) => typeof value === "string" ? value.trim() : ""
/** "(€387)", "(€140.91)": the price as the quote gives it, never rounded away from the figure next to it. */
const euros = (cents: number | null | undefined) => cents ? ` (€${cents % 100 ? (cents / 100).toFixed(2) : cents / 100})` : ""
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/** "Vela Coast Lines, West Baltic (Hamburg) to South Finland (Helsinki), departs Sat 24 Oct 14:00 CEST" → "Sat 24 Oct 14:00 CEST sailing from Hamburg to Helsinki" */
function sailing(label: string): string {
  const match = label.match(/\(([^)]+)\) to [^(]*\(([^)]+)\), departs ([^,]+)/)
  return match ? `${match[3]} sailing from ${match[1]} to ${match[2]}` : label || "the chosen sailing"
}

export type StepZones = { pickup: string | null; delivery: string | null }

/** One step as a clause. `shown` says the card shows the message texts right below. */
export function stepWords(step: CardStep, zones: StepZones, shown = false): string | null {
  const lookup = (step.params.lookup && typeof step.params.lookup === "object" ? step.params.lookup : {}) as Lookup
  const label = str(lookup.label)
  const to = str(step.params.to)
  switch (step.action) {
    // The Executor checks the sailing again before it books: a quote is not held space.
    case "book_ferry": return `the ${sailing(label)} is booked if it still has space${euros(lookup.price_cents)}`
    case "change_ferry_booking": return `the ferry booking moves to the ${sailing(label)} if it still has space${euros(lookup.price_cents)}`
    case "book_hotel": return `${label.split(",")[0] || "a hotel"} is booked for the driver${euros(lookup.price_cents)}`
    case "book_driver_travel": return `the driver's ${label || "travel"} is booked${euros(lookup.price_cents)}`
    case "cancel_driver_travel": {
      const what = lower(str(step.params.text).replace(/^cancel\s+/i, "").replace(/[.\s]+$/, "")) || "the driver's booked travel"
      return `${what} ${/ and /.test(what) ? "are" : "is"} cancelled`
    }
    case "switch_driver": return `the gig is offered to ${str(step.params.name) || label || "the backup driver"} directly`
    case "republish_offer": return "the gig is offered to drivers again"
    case "raise_fee": return `the driver fee goes up by €${Number(step.params.amount_eur ?? 0)}`
    case "change_pickup_time": return `the pickup moves to ${range(step.params.start, step.params.end, zones.pickup) || "a new time"}`
    case "change_delivery_time": return `the promised delivery moves to ${range(step.params.start, step.params.end, zones.delivery) || "a new time"}`
    case "book_tow": return `a tow is booked with ${label || "the recovery firm"}`
    case "approve_repair_cost": return `a repair cost${step.params.amount_eur ? ` of €${Number(step.params.amount_eur)}` : ""} is agreed with ${label || "the workshop"}`
    case "message_customer": return shown ? `the email below goes to ${to || "the customer"}` : `an email goes to ${to || "the customer"} (its text is in the card)`
    // The Executor hands a call to the person who approved it: nothing dials by itself.
    case "call_customer":
    case "call_contact": return `you call ${to || (step.action === "call_customer" ? "the customer" : "the contact")}`
    case "message_driver": return `the driver gets ${shown ? "the message below" : "a message"}`
    case "note": {
      const minutes = Number(step.params.minutes ?? 0)
      return minutes ? `the agent checks again in ${minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`}` : null
    }
    default: return null
  }
}

/** The same clauses as a list, for the card's "If you approve" box: "You call Calverin Car Centre", "The driver gets a message". */
export function stepList(option: CardOption, zones: StepZones, shown = false): string[] {
  if (option.kind === "answer") return ["The agent carries on from your answer; nothing is booked or sent"]
  const steps = option.steps?.length ? option.steps : [{ action: option.action, params: option.params }]
  const ordered = [...steps.filter((step) => step.action !== "note"), ...steps.filter((step) => step.action === "note")]
  const words = ordered.map((step) => stepWords(step, zones, shown)).filter((text): text is string => !!text)
  if (!words.length && steps.every((step) => step.action === "note")) return ["Nothing changes; the plan stays as it is"]
  // An offer to another driver leaves the current driver's travel alone until the new one accepts (a rule in code).
  if (steps.some((step) => step.action === "switch_driver") && !steps.some((step) => step.action === "cancel_driver_travel")) {
    words.push("travel booked for the current driver stays booked until the new driver accepts; then a card asks you to cancel it")
  }
  return words.map((text) => text.charAt(0).toUpperCase() + text.slice(1))
}

/** "you call Calverin Car Centre, the driver gets the message below and the agent checks again in 45 min" */
export function optionWords(option: CardOption, zones: StepZones, shown = false): string | null {
  if (option.kind === "answer") return "the agent carries on from your answer; nothing is booked or sent"
  const steps = option.steps?.length ? option.steps : [{ action: option.action, params: option.params }]
  // What changes first, the agent's own next look last, whatever order the agent wrote them in.
  const ordered = [...steps.filter((step) => step.action !== "note"), ...steps.filter((step) => step.action === "note")]
  const words = ordered.map((step) => stepWords(step, zones, shown)).filter((text): text is string => !!text)
  if (!words.length) return steps.every((step) => step.action === "note") ? "nothing changes; the plan stays as it is" : null
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
}
