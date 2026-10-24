// The case file as compact text for an agent (SPEC 7): about 2,000 tokens, one
// line per item with who said it, when, and a short handle in brackets ([E12])
// that stands for the timeline entry id, so a finding can cite it. Handles are
// per run (lib/agents/refs.ts) and map back to real entry ids in code; full ids
// cost ~20 tokens each and would double the size. Written by code from the same
// case file the order page shows, so the agent and the person read the same facts.

import type { CaseFile, SourceRef, TimelineItem } from "../case"
import { orderView } from "../queue"
import { at, clock, duration, minutesUntil, range, zoneShort } from "../time"
import type { Refs } from "./refs"

const MESSAGE_CHARS = 280

function placeText(place: CaseFile["order"]["route"]["from"]): string {
  if (!place) return "unknown place"
  return place.kind === "private" ? `private address, ${place.city}` : `${place.name}, ${place.city}`
}

export function clip(text: string, max = MESSAGE_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/** Words that keep evidence honest, next to the entry they belong to. */
function marker(item: TimelineItem): string {
  if (item.status === "quote") return " (QUOTE, NOT BOOKED)"
  if (item.source === "quote") return " (AVAILABILITY CHECK, NOT BOOKED)"
  if (item.source === "booking" && item.status === "booked") return " (BOOKED)"
  if (item.source === "booking" && item.status === "superseded") return " (BOOKING LOST)"
  if (item.kind === "alert") return item.status === "done" ? " (closed)" : " (A SIGNAL, NOT A DIAGNOSIS)"
  if (item.channel === "ferry_schedule_inference") return " (ESTIMATE FROM A TIMETABLE, NOT A POSITION)"
  if (item.source === "gps") return " (km to go and ETA are for the delivery address)"
  return ""
}

function who(item: TimelineItem): string {
  if (item.source === "gps") return "GPS"
  if (item.kind === "message") return `${item.authorLabel ?? "Someone"} (${item.sourceLabel}${item.visibility === "internal" ? ", internal" : ""})`
  return item.authorLabel ?? item.sourceLabel
}

function timelineLine(item: TimelineItem, zone: string | null, refs: Refs): string {
  const text = item.kind === "message" && item.body ? `"${clip(item.body)}"` : clip(item.summary, 200)
  const late = item.receivedAt ? -(minutesUntil(item.receivedAt, item.at) ?? 0) : 0
  const arrived = late >= 10 ? ` (arrived ${duration(late)} later)` : ""
  return `${clock(item.at, zone)} ${who(item)}: ${text}${marker(item)}${arrived} ${refs.cite(item.id)}`
}

/** Timeline lines grouped by day. Stage changes are dropped; runs of GPS positions keep the newest three. */
function timelineBlock(items: TimelineItem[], zone: string | null, refs: Refs): string[] {
  const lines: string[] = []
  const kept = items.filter((item) => item.source !== "system")
  let day = ""
  let gpsRun: TimelineItem[] = []
  const flushGps = () => {
    if (gpsRun.length > 3) {
      const rest = gpsRun.slice(3)
      lines.push(`   … ${rest.length} more GPS positions: ${rest.map((item) => `${item.summary.match(/(\d[\d,]*) km to go/)?.[1] ?? "?"} km at ${clock(item.at, zone)}`).join(", ")}`)
    }
    gpsRun = []
  }
  for (const item of kept) {
    const label = at(item.at, zone).split(" ").slice(0, 3).join(" ")
    if (label !== day) { flushGps(); day = label; lines.push(label) }
    if (item.source === "gps") {
      gpsRun.push(item)
      if (gpsRun.length > 3) continue
    } else flushGps()
    lines.push(timelineLine(item, zone, refs))
  }
  flushGps()
  return lines
}

export function caseText(file: CaseFile, refs: Refs): string {
  const { order, open, plan } = file
  const zone = orderView(file).zone
  const zoneCity = (order.pickedUpAt || order.stage.key === "delivered" ? order.route.to?.city : order.route.from?.city) ?? "local"
  const now = new Date(file.asOf)
  const lines: string[] = []
  const add = (text = "") => lines.push(text)
  const cite = (source: SourceRef | { entryId: string | null }) => source.entryId ? ` ${refs.cite(source.entryId)}` : ""
  const when = (iso: string | null, placeZone = zone) => iso ? at(iso, placeZone) : "time not recorded"

  add(`${order.reference} · ${order.car.label}${order.car.year ? ` ${order.car.year}` : ""}${order.car.registration ? ` · plate ${order.car.registration}` : ""} · ${order.stage.label}`)
  add(`Customer (pays; any contact needs a person's approval): ${order.customer.name}${order.customerReference ? `, their reference ${order.customerReference}` : ""}`)
  add(`Route: ${placeText(order.route.from)} → ${order.route.via ? `${placeText(order.route.via)} → ` : ""}${placeText(order.route.to)} · ${order.route.distanceKm ?? "?"} km${order.route.ferry ? " · with ferry" : ""}`)
  add(`Driver: ${order.driver ? `${order.driver.name}, ${order.driver.state}${order.driver.home ? `, lives in ${order.driver.home}` : ""}` : "none booked"}${order.otherDrivers.length ? ` · other drivers: ${order.otherDrivers.map((d) => `${d.name} (${d.state})`).join(", ")}` : ""}`)
  if (order.tradeIn) add(`Trade-in car on the same order: ${order.tradeIn.label}`)
  // "Now" in every zone the order's key times use, so the agent never converts zones itself.
  const zones = new Map<string, string[]>()
  for (const [z, city] of [[zone, zoneCity], ...file.keyTimes.map((time) => [time.zone, time.place] as const)]) {
    if (!z || !city) continue
    const local = clock(now, z)
    const cities = zones.get(local) ?? []
    if (!cities.includes(city)) cities.push(city)
    zones.set(local, cities)
  }
  const nowParts = [...zones.entries()].map(([local, cities]) => `${local} in ${cities.join(" and ")}`)
  add(`Now: ${at(now, zone).split(" ").slice(0, 3).join(" ")}, ${nowParts.join(", ")} (${clock(now, "UTC")} UTC). Timeline times are ${zoneCity} time (${zoneShort(now, zone)}); key times are in their own place's time.`)

  add("\nKEY TIMES")
  if (!file.keyTimes.length) add("- none recorded")
  for (const time of file.keyTimes) {
    add(`- ${time.label}${time.place ? `, ${time.place}` : ""}: ${range(time.start, time.end, time.zone)}${time.note ? `. ${time.note}` : ""}. Source: ${time.source.label}${cite(time.source)}`)
  }

  const current = file.facts.filter((fact) => !fact.historical && !(fact.kind === "agreement" && /^(Pickup slot|Delivery promise)/.test(fact.subject)))
  add("\nAGREED AND STATED")
  if (!current.length) add("- nothing for this stage")
  for (const fact of current) add(`- ${fact.subject}: ${fact.value} (${fact.status === "verified" ? "confirmed" : "stated, not confirmed"}; ${fact.source.label})${cite(fact.source)}`)
  const historical = file.facts.filter((fact) => fact.historical).length
  if (historical) add(`- (${historical} details from before the ${order.stage.key === "delivered" ? "handovers" : "pickup"} are historical, left out)`)

  add("\nOPEN")
  for (const alert of open.alerts) add(`- Alert (${alert.severity}, ${alert.taken ? `taken by ${alert.owner ?? "a desk"}, not resolved` : "nobody has taken it"}), raised ${when(alert.at)}: ${alert.label}. "${clip(alert.summary, 180)}" A signal, not a diagnosis${cite(alert.source)}`)
  for (const incident of open.incidents) add(`- Incident (${incident.status}, ${incident.owner ?? "no owner"}): ${incident.label}.${incident.notes ? ` ${clip(incident.notes, 300)}` : ""}${cite(incident.source)}`)
  for (const task of open.tasks) add(`- Task for ${task.owner ?? "Ops"}: ${task.label}.${task.nextAction ? ` Next step written by a person: "${clip(task.nextAction, 240)}"` : ""}${cite(task.source)}`)
  for (const proposal of open.proposals) add(`- Earlier agent proposal (${proposal.state}): ${proposal.summary}${proposal.detail ? ` ${clip(proposal.detail, 200)}` : ""}${cite(proposal.source)}`)
  // The temporary card built by code from an alert is a reminder, not an agent's finding; agents see only agent cards.
  for (const card of open.cards) if (card.origin === "agent") add(`- An agent card already waits for a person: "${card.headline}"`)
  for (const claim of open.claims) add(`- Unresolved handover claim: ${clip(claim.text, 200)}${cite(claim.source)}`)
  for (const thread of open.conversations) {
    if (thread.unanswered && thread.lastInbound) add(`- Not answered yet: ${thread.lastInbound.author} (${thread.channel.toLowerCase()}), ${when(thread.lastInbound.source.at)}${cite(thread.lastInbound.source)}`)
  }
  for (const support of open.supportInbox) add(`- ${support.linked ? "Open support request" : "Support message NOT linked to this order, may concern it (not confirmed)"}: ${support.topic}${support.basis ? `. ${clip(support.basis, 200)}` : ""}${cite(support.source)}`)
  for (const doc of open.documents) add(`- Document ${doc.state}: ${doc.label}${cite(doc.source)}`)
  if (![...Object.values(open)].some((list) => list.length)) add("- nothing open")

  add("\nROUTE AND TRAVEL")
  for (const leg of plan.legs) add(`- Leg: ${leg.from} → ${leg.to}, ${leg.mode.toLowerCase()}, ${leg.distanceKm ?? "?"} km, ${leg.status}${leg.driver ? `, ${leg.driver}` : ""}`)
  if (plan.offer) add(`- Driver gig: ${plan.offer.state}${plan.offer.fee ? `, fee ${plan.offer.fee}` : ""}`)
  const booked = plan.bookings.filter((booking) => booking.state === "booked")
  add(booked.length ? "BOOKED (real reservations):" : "BOOKED: nothing is booked for this order")
  for (const booking of booked) add(`- ${booking.summary}${cite(booking.source)}`)
  for (const booking of plan.bookings.filter((b) => b.state === "lost")) add(`- No longer valid: ${booking.summary}${cite(booking.source)}`)
  if (plan.quotes.length) add("QUOTES AND AVAILABILITY CHECKS (NOT bookings):")
  for (const quote of plan.quotes) add(`- ${quote.state === "sold out" ? "Sold out" : "Quote"}: ${quote.summary.replace(/^Ferry (quote, not booked|sold out): /, "")}, checked ${when(quote.checkedAt)}${cite(quote.source)}`)
  if (plan.terminalDrive) {
    const t = plan.terminalDrive
    add(`- Planning estimate (a range from a planning table, not live traffic, not a position): ${t.from} to ${t.terminal} in ${t.city} is about ${t.km ?? "?"} km, ${t.minutesLow != null ? duration(t.minutesLow) : "?"} to ${t.minutesHigh != null ? duration(t.minutesHigh) : "?"} of driving without breaks or check-in${cite(t.source)}`)
  }
  if (plan.lastPosition) {
    const p = plan.lastPosition
    add(`LAST GPS: ${p.kmToGo ?? "?"} km to go, ${p.quality} signal, observed ${when(p.at)} (${duration(-(minutesUntil(p.at, now) ?? 0))} ago)${p.eta ? `, app ETA at the delivery address ${at(p.eta, order.route.to?.zone)}` : ""}. GPS gives km to go and an ETA, no map position${cite(p.source)}`)
  }

  add(`\nTIMELINE (newest first; the ${file.timeline.length} most recent entries, stage changes left out; use timeline() for older ones)`)
  lines.push(...timelineBlock(file.timeline, zone, refs))
  return lines.join("\n")
}

/** Timeline entries as the same compact lines, oldest first, for the timeline tool. */
export function timelineText(items: TimelineItem[], zone: string | null, refs: Refs): string {
  if (!items.length) return "No entries in that range."
  return timelineBlock(items, zone, refs).join("\n")
}
