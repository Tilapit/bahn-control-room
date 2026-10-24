// Turns the seeded snapshot into one timeline per order. Every entry is written
// by code from the record's fields (no LLM) and points back to its record.
// Pure: the script loads the rows, this module returns what to store.

import { Directory } from "../present/actors"
import { num, obj, str, strings } from "../present/bundle"
import { humanize, label } from "../present/labels"
import type { Evidence } from "../schema"
import { at, clock, range } from "../time"
import {
  boundaryLabel, claimSourceLabel, documentLabel, expenseLabel, incidentLabel, money, oneLine, proofLabel,
  signalLabel, severityWord, taskLabel, travelLabel, windowSourceLabel,
} from "../words"
import { type EntryKind, type EntryStatus, type Source, sourceForChannel } from "./sources"

type Row = Record<string, unknown>

export type DatasetRows = {
  orders: { id: string; reference: string; customerId: string; createdAt: Date; details: Row }[]
  customers: { id: string; name: string }[]
  drivers: { id: string; displayName: string; homeCity: string; homeCountry: string }[]
  sites: { id: string; name: string; city: string; details: Row }[]
  addresses: { id: string; name: string; city: string; country: string; details: Row }[]
  vehicles: { id: string; make: string; model: string; modelYear: number; registration: string | null; syntheticVin: string | null }[]
  orderItems: { id: string; orderId: string; vehicleId: string; role: string }[]
  conversations: { id: string; orderId: string; channel: string; details: Row }[]
  messages: { id: string; orderId: string; conversationId: string; authorType: string; body: string; authoredAt: Date; details: Row }[]
  alerts: { id: string; orderId: string; severity: string; signal: string; status: string; summary: string; triggeredAt: Date; details: Row }[]
  events: { id: string; orderId: string; command: string; targetType: string; targetId: string; recordedAt: Date; details: Row }[]
  related: { collection: string; id: string; orderId: string | null; details: Row }[]
}

export type NewEntry = {
  id: string
  orderId: string | null
  occurredAt: Date
  receivedAt: Date | null
  source: Source
  channel: string | null
  authorType: string | null
  authorId: string | null
  authorLabel: string | null
  kind: EntryKind
  summary: string
  body: string | null
  status: EntryStatus | null
  visibility: "public" | "internal"
  evidence: Evidence
  language: string | null
}

export type NewFact = {
  id: string
  orderId: string
  subject: string
  value: string
  status: "claimed" | "verified" | "superseded"
  sourceEntryId: string
  statedByLabel: string
  statedAt: Date
  supersededBy: string | null
  kind: "fact" | "agreement"
}

export type SearchDoc = { orderId: string; reference: string; content: string }

/** Separates the header fields of a search document from its message text. */
export const SEARCH_SEPARATOR = "\n§\n"

const SYSTEM_ACTORS: Record<string, string> = { "routing-service": "Alert routing", system: "System", operator: "Ops" }

const INBOUND = new Set(["driver", "customer", "site_contact", "handoff_contact"])

// Events that only repeat a record that already has its own entry.
const DUPLICATE_EVENTS = new Set([
  "alert.raised", "alert.acknowledged", "alert.resolved", "incident.opened", "work_item.opened", "work.opened",
  "travel.booked", "travel.check_in_rejected", "travel.gate_exception_recorded", "travel.check_in_confirmed",
  "proof.submitted", "proof.approved", "proof.review", "expense.submitted", "expense.reviewed", "expense.auto_recorded",
  "expense.superseded", "message.sent", "site_visit.arrived", "pickup.attempted", "endpoint.claim_recorded",
  "endpoint.claim_resolved", "travel.arrival_reported", "vehicle.custody_reported", "document.verified",
  // The booking event at the same minute says the same thing.
  "offer.accepted",
])

/** A whole short message; long ones are cut at a word boundary. */
const clip = (text: string, max = 240): string => {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`
}

const sentence = (text: string | null): string | null => text ? (/[.!?]$/.test(text) ? text : `${text}.`) : null

const date = (value: unknown): Date | null => {
  const text = str(value)
  if (!text) return null
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function buildTimeline(data: DatasetRows): { entries: NewEntry[]; facts: NewFact[]; search: SearchDoc[] } {
  const byCollection = new Map<string, DatasetRows["related"]>()
  for (const row of data.related) {
    const list = byCollection.get(row.collection) ?? []
    list.push(row)
    byCollection.set(row.collection, list)
  }
  const related = (collection: string) => byCollection.get(collection) ?? []

  const orders = new Map(data.orders.map((order) => [order.id, order]))
  const customers = new Map(data.customers.map((customer) => [customer.id, customer]))
  const addresses = new Map(data.addresses.map((address) => [address.id, address]))
  const sites = new Map(data.sites.map((site) => [site.id, site]))
  const points = new Map(related("transport_points").map((row) => [row.id, row]))
  const plans = new Map(related("transport_plans").map((row) => [row.id, row]))
  const terminals = new Map(related("ferry_terminals").map((row) => [row.id, row]))
  const conversations = new Map(data.conversations.map((thread) => [thread.id, thread]))
  const endpointDetails = new Map(related("order_endpoint_details").map((row) => [row.id, row]))
  const inboxThreads = new Map(related("support_inbox_threads").map((row) => [row.id, row]))

  const snapshotNames = new Map<string, string>()
  for (const message of [...data.messages.map((m) => m.details), ...related("support_inbox_messages").map((m) => m.details)]) {
    const id = str(message.author_id)
    const name = str(message.author_name_snapshot)
    if (id && name && !snapshotNames.has(id)) snapshotNames.set(id, name)
  }
  const dir = new Directory({
    drivers: data.drivers,
    operators: related("operators").map((row) => ({ id: row.id, ...row.details })),
    agents: related("agents").map((row) => ({ id: row.id, ...row.details })),
    customers: data.customers,
    sites: data.sites,
    endpointDetails: related("order_endpoint_details").map((row) => ({ id: row.id, ...row.details })),
    snapshots: snapshotNames,
  })

  // City and terminal names to time zones, so a train or ferry time reads in local time.
  const cityZone = new Map<string, string>()
  for (const address of data.addresses) {
    const zone = str(address.details.timezone)
    if (zone && !cityZone.has(address.city)) cityZone.set(address.city, zone)
  }
  for (const terminal of terminals.values()) {
    const zone = str(terminal.details.timezone)
    const city = str(terminal.details.city)
    if (zone && city && !cityZone.has(city)) cityZone.set(city, zone)
  }
  const terminalZone = (id: unknown, name?: unknown): string | null => {
    const byId = terminals.get(String(id ?? ""))
    if (byId) return str(byId.details.timezone)
    const text = String(name ?? "").toLowerCase()
    for (const terminal of terminals.values()) {
      const terminalName = String(terminal.details.name ?? "").toLowerCase().replace(" vehicle terminal", "")
      if (terminalName && text.startsWith(terminalName)) return str(terminal.details.timezone)
    }
    return null
  }
  const zoneOfCity = (city: unknown) => cityZone.get(String(city ?? "")) ?? null
  const addressZone = (addressId: unknown) => str(addresses.get(String(addressId ?? ""))?.details.timezone)
  const orderZone = (orderId: string, boundary: "pickup" | "delivery") => {
    const order = orders.get(orderId)
    return order ? addressZone(order.details[boundary === "pickup" ? "pickup_address_id" : "delivery_address_id"]) : null
  }
  const pointPlace = (pointId: unknown): { name: string; zone: string | null; role: string | null } | null => {
    const point = points.get(String(pointId ?? ""))
    if (!point) return null
    const address = addresses.get(String(point.details.address_id ?? ""))
    if (!address) return null
    const name = address.name === "Private handoff" ? `private address in ${address.city}` : `${address.name}, ${address.city}`
    return { name, zone: str(address.details.timezone), role: str(point.details.role) }
  }

  const entries: NewEntry[] = []
  const facts: NewFact[] = []
  const used = new Set<string>()
  const push = (entry: Omit<NewEntry, "receivedAt" | "language" | "body" | "status" | "channel" | "authorType" | "authorId" | "authorLabel"> & Partial<NewEntry>) => {
    if (used.has(entry.id)) return
    used.add(entry.id)
    entries.push({
      receivedAt: null, language: null, body: null, status: null, channel: null, authorType: null, authorId: null, authorLabel: null,
      ...entry,
    })
  }
  const actor = (id: unknown, type: unknown) => dir.resolve(id, type)
  const deskTitle = (id: unknown) => SYSTEM_ACTORS[String(id)] ?? dir.title(id) ?? "Ops"

  // ---- messages -----------------------------------------------------------
  for (const message of data.messages) {
    const d = message.details
    const thread = conversations.get(message.conversationId)
    const orderIds = [...new Set([message.orderId, thread?.orderId, ...strings(thread?.details.related_order_ids)].filter((id): id is string => !!id))]
    const who = actor(d.author_id, d.author_type)
    const channel = str(d.channel)
    orderIds.forEach((orderId, index) => push({
      id: index === 0 ? `messages:${message.id}` : `messages:${message.id}@${orderId}`,
      orderId,
      occurredAt: message.authoredAt,
      receivedAt: message.authoredAt,
      source: sourceForChannel(channel),
      channel,
      authorType: message.authorType,
      authorId: str(d.author_id),
      authorLabel: who.name,
      kind: "message",
      summary: clip(message.body),
      body: message.body,
      status: INBOUND.has(message.authorType) ? "claimed" : null,
      visibility: d.visibility === "INTERNAL" ? "internal" : "public",
      evidence: { table: "messages", id: message.id },
      language: str(d.language),
    }))
  }

  // ---- support inbox (before an order link is certain) --------------------
  for (const row of related("support_inbox_messages")) {
    const d = row.details
    const thread = inboxThreads.get(String(d.thread_id ?? ""))
    const linked = strings(thread?.details.linked_order_ids)
    const who = actor(d.author_id, d.author_type)
    const channel = str(d.channel)
    const base = {
      occurredAt: date(d.authored_at) ?? new Date(0),
      receivedAt: date(d.authored_at),
      source: sourceForChannel(channel),
      channel,
      authorType: str(d.author_type),
      authorId: str(d.author_id),
      authorLabel: who.name,
      kind: "message" as const,
      summary: clip(String(d.body ?? "")),
      body: String(d.body ?? ""),
      status: INBOUND.has(String(d.author_type)) ? "claimed" as const : null,
      visibility: d.visibility === "INTERNAL" ? "internal" as const : "public" as const,
      evidence: { table: "support_inbox_messages", id: row.id },
      language: str(d.language),
    }
    // Only confirmed links file a message under an order. Candidates stay unlinked.
    if (!linked.length) push({ ...base, id: `support_inbox_messages:${row.id}`, orderId: null })
    linked.forEach((orderId, index) => push({ ...base, id: index === 0 ? `support_inbox_messages:${row.id}` : `support_inbox_messages:${row.id}@${orderId}`, orderId }))
  }

  // ---- internal room posts ------------------------------------------------
  for (const row of related("internal_notifications")) {
    const d = row.details
    const room = str(d.destination)
    push({
      id: `internal_notifications:${row.id}`, orderId: row.orderId, occurredAt: date(d.occurred_at) ?? new Date(0),
      source: "slack", channel: "internal_notification",
      authorType: dir.title(d.actor_id) && related("agents").some((a) => a.id === d.actor_id) ? "agent" : "operator",
      authorId: str(d.actor_id), authorLabel: `${deskTitle(d.actor_id)}${room ? ` in #${room}` : ""}`,
      kind: "message", summary: clip(String(d.preview ?? "")), body: str(d.preview),
      visibility: "internal", evidence: { table: "internal_notifications", id: row.id },
    })
  }

  // ---- order notes ----------------------------------------------------------
  for (const row of related("order_notes")) {
    const d = row.details
    const customer = d.author_type === "customer"
    push({
      id: `order_notes:${row.id}`, orderId: row.orderId, occurredAt: date(d.authored_at) ?? new Date(0),
      source: customer ? "order" : "slack", channel: "order_note",
      authorType: str(d.author_type), authorId: str(d.author_id), authorLabel: actor(d.author_id, d.author_type).name,
      kind: "message", summary: clip(String(d.body ?? "")), body: str(d.body),
      status: customer ? "claimed" : null, visibility: "internal", evidence: { table: "order_notes", id: row.id },
    })
  }

  // ---- GPS ------------------------------------------------------------------
  for (const row of related("tracking_observations")) {
    const d = row.details
    if (!row.orderId) continue
    const zone = orderZone(row.orderId, "delivery")
    const eta = str(d.estimated_delivery_at)
    const km = num(d.distance_remaining_km)
    const progress = num(d.progress_fraction)
    const inferred = d.source === "ferry_schedule_inference"
    const stale = d.location_quality === "STALE"
    const summary = inferred
      ? `Estimated from the ferry timetable, not a position${eta ? `: ETA ${at(eta, zone)}` : ""}`
      : `${stale ? "Stale" : "Coarse"} app position: ${km ?? "?"} km to go${progress != null ? ` (${Math.round(progress * 100)}% of the drive)` : ""}${eta ? `, ETA ${at(eta, zone)}` : ""}`
    push({
      id: `tracking_observations:${row.id}`, orderId: row.orderId,
      occurredAt: date(d.observed_at) ?? new Date(0), receivedAt: date(d.received_at),
      source: "gps", channel: str(d.source), authorType: "system", authorLabel: inferred ? "Ferry timetable" : "Driver app",
      kind: "position", summary, body: str(d.context_note), status: "signal", visibility: "internal",
      evidence: { table: "tracking_observations", id: row.id },
    })
  }

  // ---- bookings and quotes ------------------------------------------------
  const bookedBy = new Map<string, { id: unknown; type: unknown }>()
  for (const event of data.events) {
    if (event.command === "travel.booked" || event.command === "travel.rebooked") bookedBy.set(event.targetId, { id: event.details.actor_id, type: event.details.actor_type })
  }
  for (const row of related("travel_reservations")) {
    const d = row.details
    if (!row.orderId) continue
    const kind = str(d.kind)
    const status = str(d.status)
    const lost = status === "MISSED_CHECK_IN" || !!str(d.cancelled_at)
    const ref = str(d.booking_reference)
    let summary: string
    let body: string | null = null
    if (kind === "FERRY") {
      const zone = terminalZone(d.origin_terminal_id, d.origin_terminal)
      const route = `${String(d.origin_terminal ?? "").replace(" Vehicle Terminal", "")} to ${String(d.destination_terminal ?? "").replace(" Vehicle Terminal", "")}`
      summary = lost
        ? `Ferry booking lost: check-in was missed for the ${at(d.departure_at, zone)} sailing (${route})`
        : `${str(d.replaces_reservation_id) ? "Replacement ferry" : "Ferry"} booked: ${route}, departs ${at(d.departure_at, zone)}, check-in closes ${clock(d.check_in_cutoff_at, zone)}`
      const confirmed = [
        d.check_in_confirmation && d.check_in_confirmation !== "UNCONFIRMED" ? `check-in ${humanize(String(d.check_in_confirmation)).toLowerCase()}` : "check-in not confirmed",
        d.boarding_confirmation && d.boarding_confirmation !== "UNCONFIRMED" ? `boarding ${humanize(String(d.boarding_confirmation)).toLowerCase()}` : "boarding not confirmed",
      ]
      body = `${ref ? `Booking ${ref}. ` : ""}A booking does not prove check-in or boarding: ${confirmed.join(", ")}.`
    } else if (kind === "HOTEL") {
      const zone = zoneOfCity(d.city)
      summary = `Hotel booked for the driver in ${str(d.city) ?? "the pickup city"}: ${at(d.check_in_at ?? d.departure_at, zone)} to ${at(d.check_out_at ?? d.expected_arrival_at, zone)}`
      body = ref ? `Booking ${ref}. A booking does not prove the driver stayed there.` : null
    } else {
      const zone = zoneOfCity(d.from_city)
      summary = `${travelLabel(kind)} booked for the driver: ${str(d.from_city) ?? "?"} to ${str(d.to_city) ?? "?"}, departs ${at(d.departure_at, zone)}`
      body = ref ? `Booking ${ref}. A ticket does not prove the driver travelled.` : null
    }
    const fare = money(num(d.fare_cents), str(d.currency))
    if (fare) body = `${body ?? ""} Fare ${fare}.`.trim()
    const by = bookedBy.get(row.id)
    push({
      id: `travel_reservations:${row.id}`, orderId: row.orderId, occurredAt: date(d.booked_at) ?? new Date(0),
      source: "booking", channel: "travel_reservation",
      authorType: str(by?.type) ?? "operator", authorId: str(by?.id), authorLabel: by ? actor(by.id, by.type).name : "Driver travel",
      kind: "booking", summary, body, status: lost ? "superseded" : "booked", visibility: "internal",
      evidence: { table: "travel_reservations", id: row.id },
    })
  }
  for (const row of related("travel_options")) {
    const d = row.details
    if (!row.orderId) continue
    const kind = str(d.kind)
    const soldOut = d.status === "SOLD_OUT"
    const zone = kind === "FERRY" ? terminalZone(null, d.from_city) : zoneOfCity(d.from_city)
    const price = money(num(d.quote_cents), str(d.currency))
    const summary = soldOut
      ? `${travelLabel(kind)} sold out: the ${at(d.departure_at, zone)} ${kind === "FERRY" ? "sailing" : "departure"} has no ${kind === "FERRY" ? "vehicle space" : "seats"}`
      : `${travelLabel(kind)} quote, not booked: ${kind === "FERRY" ? `${str(d.provider) ?? "ferry"}, ` : `${str(d.from_city) ?? "?"} to ${str(d.to_city) ?? "?"}, `}departs ${at(d.departure_at, zone)}${price ? `, ${price}` : ""}`
    push({
      id: `travel_options:${row.id}`, orderId: row.orderId, occurredAt: date(d.checked_at) ?? new Date(0),
      source: "quote", channel: "travel_option", authorType: "system", authorLabel: str(d.provider) ?? "Travel search",
      kind: "quote", summary, body: [sentence(str(d.capacity_note)), kind === "FERRY" && d.check_in_cutoff_at ? `Check-in would close ${at(str(d.check_in_cutoff_at), zone)}.` : null, `Checked ${at(str(d.checked_at), zone)}; availability can change.`].filter(Boolean).join(" ") || null,
      // A sold-out check has no price: it is not a quote, and not a booking.
      status: soldOut ? null : "quote", visibility: "internal", evidence: { table: "travel_options", id: row.id },
    })
  }

  // ---- alerts, incidents, work --------------------------------------------
  for (const alert of data.alerts) {
    const d = alert.details
    const closed = alert.status === "RESOLVED" || alert.status === "DISMISSED"
    push({
      id: `alerts:${alert.id}`, orderId: alert.orderId, occurredAt: alert.triggeredAt,
      source: "alert", channel: "alert", authorType: "system", authorLabel: "Monitoring",
      kind: "alert", summary: `${signalLabel(alert.signal)} (${severityWord(alert.severity)} alert)`, body: alert.summary,
      status: closed ? "done" : "signal", visibility: "internal", evidence: { table: "alerts", id: alert.id },
    })
    const acknowledgedAt = date(d.acknowledged_at)
    if (acknowledgedAt) push({
      id: `alerts:${alert.id}:ack`, orderId: alert.orderId, occurredAt: acknowledgedAt,
      source: "person", channel: "alert", authorType: "operator", authorId: str(d.owner), authorLabel: deskTitle(d.owner),
      kind: "event", summary: `${deskTitle(d.owner)} took the alert: ${signalLabel(alert.signal).toLowerCase()}`,
      body: str(d.acknowledgement_reason) ? `${d.acknowledgement_reason} Taking an alert is not resolving it.` : "Taking an alert is not resolving it.",
      visibility: "internal", evidence: { table: "alerts", id: alert.id },
    })
    const resolvedAt = date(d.resolved_at)
    if (resolvedAt) push({
      id: `alerts:${alert.id}:resolved`, orderId: alert.orderId, occurredAt: resolvedAt,
      source: "person", channel: "alert", authorType: "operator", authorId: str(d.owner), authorLabel: deskTitle(d.owner),
      kind: "event", summary: `Alert closed: ${signalLabel(alert.signal).toLowerCase()}`, body: str(d.resolution_reason),
      status: "done", visibility: "internal", evidence: { table: "alerts", id: alert.id },
    })
  }

  const openedBy = new Map<string, { id: unknown; type: unknown }>()
  for (const event of data.events) {
    if (event.command === "incident.opened" || event.command === "work_item.opened" || event.command === "work.opened") {
      openedBy.set(event.targetId, { id: event.details.actor_id, type: event.details.actor_type })
    }
  }
  for (const row of related("incidents")) {
    const d = row.details
    const notes = [
      str(d.reported_symptom) ? `Reported: ${d.reported_symptom}.` : null,
      str(d.reported_stop_text) ? `${d.reported_stop_text}.` : null,
      d.location_verified === false ? "Location not verified." : null,
      d.warning_photo_status === "REQUESTED" ? "Photo requested, not received." : null,
      d.recovery_decision === "PENDING_CUSTOMER" ? "Recovery decision waits for the car's owner." : null,
    ].filter(Boolean)
    const by = openedBy.get(row.id)
    push({
      id: `incidents:${row.id}`, orderId: row.orderId, occurredAt: date(d.opened_at) ?? new Date(0),
      source: "person", channel: "incident", authorType: "operator", authorId: str(by?.id) ?? str(d.owner),
      authorLabel: deskTitle(by?.id ?? d.owner),
      kind: "event", summary: `Incident opened: ${incidentLabel(str(d.kind))}`, body: notes.join(" ") || null,
      status: str(d.resolved_at) ? "done" : "signal", visibility: "internal", evidence: { table: "incidents", id: row.id },
    })
  }

  for (const row of related("work_items")) {
    const d = row.details
    const system = d.created_by === "system"
    const owner = deskTitle(d.owner)
    push({
      id: `work_items:${row.id}`, orderId: row.orderId, occurredAt: date(d.opened_at) ?? new Date(0),
      source: system ? "system" : "person", channel: "work_item", authorType: system ? "system" : "operator",
      authorId: str(d.created_by), authorLabel: system ? "System check" : deskTitle(d.created_by),
      kind: "event", summary: `Task for ${owner}: ${taskLabel(str(d.kind))}`,
      body: [str(d.summary), str(d.next_action) ? `Next: ${d.next_action}` : null].filter(Boolean).join(" "),
      status: str(d.closed_at) ? "done" : "signal", visibility: "internal", evidence: { table: "work_items", id: row.id },
    })
    const closedAt = date(d.closed_at)
    if (closedAt) push({
      id: `work_items:${row.id}:closed`, orderId: row.orderId, occurredAt: closedAt,
      source: "person", channel: "work_item", authorType: "operator", authorId: str(d.owner), authorLabel: owner,
      kind: "event", summary: `Task done: ${taskLabel(str(d.kind))}`, body: str(d.outcome) ? label(String(d.outcome)) : null,
      status: "done", visibility: "internal", evidence: { table: "work_items", id: row.id },
    })
  }

  // ---- earlier agent proposals in the snapshot ----------------------------
  for (const row of related("agent_proposals")) {
    const d = row.details
    const review = obj(d.review)
    const execution = obj(d.execution)
    const pending = d.status === "PENDING_REVIEW"
    push({
      id: `agent_proposals:${row.id}`, orderId: row.orderId, occurredAt: date(d.created_at) ?? new Date(0),
      source: "agent", channel: "agent_proposal", authorType: "agent", authorId: str(d.proposed_by_agent_id),
      authorLabel: deskTitle(d.proposed_by_agent_id),
      kind: "proposal", summary: `Proposed: ${String(d.summary ?? "").replace(/\.$/, "")}${pending ? ". Waiting for review" : ""}`,
      body: str(d.rationale), visibility: "internal", evidence: { table: "agent_proposals", id: row.id },
    })
    const reviewedAt = date(review?.reviewed_at)
    if (review && reviewedAt) {
      const verb = review.decision === "REJECTED" ? "Rejected" : review.decision === "EDITED" ? "Approved with changes" : "Approved"
      push({
        id: `agent_proposals:${row.id}:review`, orderId: row.orderId, occurredAt: reviewedAt,
        source: "person", channel: "agent_proposal", authorType: "operator", authorId: str(review.reviewer_id),
        authorLabel: deskTitle(review.reviewer_id),
        kind: "decision", summary: `${verb}: ${String(d.summary ?? "").replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}`,
        body: str(review.decision_note), status: "done", visibility: "internal", evidence: { table: "agent_proposals", id: row.id },
      })
    }
    const attemptedAt = date(execution?.attempted_at)
    if (execution && attemptedAt) {
      const failed = execution.status === "FAILED"
      push({
        id: `agent_proposals:${row.id}:execution`, orderId: row.orderId, occurredAt: attemptedAt,
        source: "agent", channel: "agent_proposal", authorType: "agent", authorId: str(d.proposed_by_agent_id),
        authorLabel: deskTitle(d.proposed_by_agent_id),
        kind: "event", summary: failed ? `Attempt failed: ${String(d.summary ?? "").replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}` : "Approved proposal carried out",
        body: str(execution.error), status: failed ? "signal" : "done", visibility: "internal",
        evidence: { table: "agent_proposals", id: row.id },
      })
    }
  }

  // ---- documents, proofs, costs --------------------------------------------
  for (const row of related("documents")) {
    const d = row.details
    const kind = str(d.kind)
    const status = str(d.status)
    let summary: string
    if (kind === "CMR") {
      summary = status === "SIGNED" && d.signature_scope === "COLLECTION_ONLY" ? `${d.medium === "PAPER" ? "Paper" : "Digital"} CMR signed at pickup only; the receiver has not signed`
        : status === "PREPARED" ? `${d.medium === "PAPER" ? "Paper" : "Digital"} CMR prepared, not signed yet`
        : `${d.medium === "PAPER" ? "Paper" : "Digital"} CMR ${label(status).toLowerCase()}`
    } else if (kind === "CONDITION_PHOTO" && status === "REQUESTED") {
      summary = "Warning light photo requested from the driver, not received"
    } else {
      summary = `${documentLabel(kind)} ${label(status).toLowerCase()}`
    }
    push({
      id: `documents:${row.id}`, orderId: row.orderId, occurredAt: date(d.updated_at) ?? new Date(0),
      source: "order", channel: "document", authorType: "system", authorLabel: "Documents",
      kind: "event", summary, status: status === "VERIFIED" ? "verified" : status === "MISSING" || status === "REQUESTED" ? "signal" : null,
      visibility: "internal", evidence: { table: "documents", id: row.id },
    })
  }

  for (const row of related("proofs")) {
    const d = row.details
    const submittedAt = date(d.submitted_at)
    const what = proofLabel(str(d.kind))
    if (submittedAt) push({
      id: `proofs:${row.id}`, orderId: row.orderId, occurredAt: submittedAt,
      source: "order", channel: "proof", authorType: "driver", authorLabel: "Driver app",
      kind: "event", summary: `${what} sent by the driver${num(d.file_count) ? ` (${num(d.file_count)} files)` : ""}${d.status === "SUBMITTED" ? ", not reviewed yet" : ""}`,
      status: "claimed", visibility: "internal", evidence: { table: "proofs", id: row.id },
    })
    const reviewedAt = date(d.reviewed_at)
    if (reviewedAt) push({
      id: `proofs:${row.id}:review`, orderId: row.orderId, occurredAt: reviewedAt,
      source: "person", channel: "proof", authorType: "operator", authorLabel: "Handover evidence",
      kind: "event", summary: `${what} ${d.status === "REJECTED" ? "rejected" : "approved"}`, body: str(d.review_note),
      status: d.status === "REJECTED" ? "superseded" : "verified", visibility: "internal", evidence: { table: "proofs", id: row.id },
    })
  }

  for (const row of related("expenses")) {
    const d = row.details
    const amount = money(num(d.amount_cents), str(d.currency))
    const what = expenseLabel(str(d.kind))
    const bahn = d.payer === "BAHN"
    const submittedAt = date(d.submitted_at) ?? date(d.service_at)
    if (submittedAt) push({
      id: `expenses:${row.id}`, orderId: row.orderId, occurredAt: submittedAt,
      source: "order", channel: "expense", authorType: bahn ? "system" : "driver", authorId: str(d.driver_id),
      authorLabel: bahn ? "Receipt matcher" : dir.driverName(d.driver_id) ?? "Driver",
      kind: "event",
      summary: bahn ? `${what} paid by Bahn: ${amount}` : `${what} cost claimed by the driver: ${amount}${str(d.merchant) ? ` at ${d.merchant}` : ""}`,
      body: d.status === "SUPERSEDED" ? "Replaced by a corrected claim." : d.status === "SUBMITTED" && !bahn ? "Not reviewed yet." : null,
      status: d.status === "SUPERSEDED" ? "superseded" : "claimed", visibility: "internal", evidence: { table: "expenses", id: row.id },
    })
    const reviewedAt = date(d.reviewed_at)
    if (reviewedAt && (d.status === "APPROVED" || d.status === "REJECTED")) push({
      id: `expenses:${row.id}:review`, orderId: row.orderId, occurredAt: reviewedAt,
      source: "person", channel: "expense", authorType: "operator", authorLabel: "Driver expense review",
      kind: "event", summary: `${what} claim ${d.status === "APPROVED" ? "approved (not paid yet)" : "rejected"}: ${amount}`,
      body: str(d.review_note), status: "done", visibility: "internal", evidence: { table: "expenses", id: row.id },
    })
  }

  // ---- physical attempts, gate records, driver reports ----------------------
  for (const row of related("site_visits")) {
    const d = row.details
    const site = sites.get(String(d.site_id ?? ""))
    push({
      id: `site_visits:${row.id}`, orderId: row.orderId, occurredAt: date(d.arrived_at) ?? new Date(0),
      source: "order", channel: "site_visit", authorType: "driver", authorLabel: "Driver app",
      kind: "event", summary: `Driver arrived at ${site ? `${site.name}, ${site.city}` : "the pickup site"}${d.outcome === "VEHICLE_NOT_FOUND" ? ": the car was not there" : ""}`,
      body: d.verified_by_site === false ? "The site has not confirmed this visit." : null,
      status: "claimed", visibility: "internal", evidence: { table: "site_visits", id: row.id },
    })
  }
  for (const row of related("ferry_terminal_events")) {
    const d = row.details
    const kind = str(d.kind)
    const summary = kind === "CHECK_IN_REJECTED" ? "Terminal gate refused check-in" : kind === "CHECK_IN_CONFIRMED" ? "Terminal gate confirmed check-in" : `Terminal gate: ${label(kind).toLowerCase()}`
    push({
      id: `ferry_terminal_events:${row.id}`, orderId: row.orderId, occurredAt: date(d.occurred_at) ?? new Date(0), receivedAt: date(d.recorded_at),
      source: "booking", channel: "terminal_gate", authorType: "system", authorLabel: "Terminal gate",
      kind: "event", summary, body: [str(d.reason), str(d.evidence_note)].filter(Boolean).join(" ") || null,
      status: "verified", visibility: "internal", evidence: { table: "ferry_terminal_events", id: row.id },
    })
  }
  for (const row of related("travel_confirmations")) {
    const d = row.details
    push({
      id: `travel_confirmations:${row.id}`, orderId: row.orderId, occurredAt: date(d.reported_at) ?? new Date(0),
      source: "order", channel: "travel_confirmation", authorType: "driver", authorId: str(d.reporter_driver_id),
      authorLabel: dir.driverName(d.reporter_driver_id) ?? "Driver",
      kind: "event", summary: `Driver reports: ${oneLine(String(d.report ?? ""))}`, body: str(d.report),
      status: "claimed", visibility: "internal", evidence: { table: "travel_confirmations", id: row.id },
    })
  }
  for (const row of related("custody_reports")) {
    const d = row.details
    const security = d.reported_security === "LOCKED_KEYS_WITH_DRIVER" ? "the car is locked and the keys are with them" : label(str(d.reported_security)).toLowerCase()
    push({
      id: `custody_reports:${row.id}`, orderId: row.orderId, occurredAt: date(d.reported_at) ?? new Date(0),
      source: "order", channel: "custody_report", authorType: "driver", authorId: str(d.driver_id),
      authorLabel: dir.driverName(d.driver_id) ?? "Driver",
      kind: "event", summary: `Driver reports ${security}`,
      body: d.location_evidence_status === "NOT_PROVIDED" ? "No parking location given. A driver report is not continuous custody." : null,
      status: "claimed", visibility: "internal", evidence: { table: "custody_reports", id: row.id },
    })
  }
  for (const row of related("custody_asset_events")) {
    const d = row.details
    const asset = related("custody_assets").find((candidate) => candidate.id === d.asset_id)
    push({
      id: `custody_asset_events:${row.id}`, orderId: row.orderId, occurredAt: date(d.occurred_at) ?? new Date(0),
      source: "order", channel: "custody", authorType: "system", authorLabel: "Key tracking",
      kind: "event", summary: `${str(asset?.details.label) ?? "Keys"}: ${oneLine(String(d.note ?? ""))}`,
      body: str(d.verification_status) ? `${label(String(d.verification_status))}; not a verified handover.` : null,
      status: "claimed", visibility: "internal", evidence: { table: "custody_asset_events", id: row.id },
    })
  }

  // ---- facts: handover instructions, contacts, claims, slots ----------------
  const confirmations = new Map<string, DatasetRows["events"][number]>()
  for (const event of data.events) {
    if (["endpoint.access_confirmed", "endpoint.contact_confirmed", "endpoint.instruction_verified"].includes(event.command)) {
      const known = confirmations.get(event.targetId)
      if (!known || known.recordedAt < event.recordedAt) confirmations.set(event.targetId, event)
    }
  }
  for (const row of related("order_endpoint_details")) {
    const d = row.details
    if (!row.orderId) continue
    const boundary = boundaryLabel(str(d.boundary))
    const siteProfile = d.stated_by === "MANAGED_SITE_PROFILE"
    const site = sites.get(String(d.site_id ?? ""))
    const customer = customers.get(orders.get(row.orderId)?.customerId ?? "")
    const statedBy = siteProfile ? `Site profile${site ? `, ${site.name}` : ""}` : d.stated_by === "CUSTOMER_ORDER_INPUT" ? `${customer?.name ?? "Customer"}, order form` : claimSourceLabel(str(d.stated_by))
    const statedAt = date(d.stated_at) ?? orders.get(row.orderId)?.createdAt ?? new Date(0)
    const entryId = `order_endpoint_details:${row.id}`
    const instruction = str(d.access_instruction)
    const contact = str(d.contact_name)
    push({
      id: entryId, orderId: row.orderId, occurredAt: statedAt,
      source: siteProfile ? "system" : "order", channel: "handover_details", authorType: siteProfile ? "system" : "customer",
      authorLabel: statedBy, kind: "fact",
      summary: `${boundary} handover: ${instruction ?? "no instruction recorded"}`,
      body: contact ? `Contact: ${contact}${str(d.contact_role) ? ` (${d.contact_role})` : ""}.` : "No contact recorded.",
      status: d.access_status === "CONFIRMED" ? "verified" : "claimed", visibility: "internal",
      evidence: { table: "order_endpoint_details", id: row.id },
    })
    const confirmation = confirmations.get(row.id)
    const confirmationEntry = confirmation ? `operational_events:${confirmation.id}` : null
    const confirmedBy = confirmation ? actor(confirmation.details.actor_id, confirmation.details.actor_type).name : null
    if (instruction) facts.push({
      id: `fact:${row.id}:access`, orderId: row.orderId, kind: "fact",
      subject: `${boundary} handover`, value: instruction,
      status: d.access_status === "CONFIRMED" ? "verified" : "claimed",
      sourceEntryId: d.access_status === "CONFIRMED" && confirmationEntry ? confirmationEntry : entryId,
      statedByLabel: d.access_status === "CONFIRMED" && confirmedBy ? confirmedBy : statedBy,
      statedAt: d.access_status === "CONFIRMED" && confirmation ? confirmation.recordedAt : statedAt, supersededBy: null,
    })
    if (contact) facts.push({
      id: `fact:${row.id}:contact`, orderId: row.orderId, kind: "fact",
      subject: `${boundary} contact`, value: `${contact}${str(d.contact_role) ? `, ${d.contact_role}` : ""}`,
      status: d.contact_status === "CONFIRMED" ? "verified" : "claimed",
      sourceEntryId: d.contact_status === "CONFIRMED" && confirmationEntry ? confirmationEntry : entryId,
      statedByLabel: d.contact_status === "CONFIRMED" && confirmedBy ? confirmedBy : statedBy,
      statedAt: d.contact_status === "CONFIRMED" && confirmation ? confirmation.recordedAt : statedAt, supersededBy: null,
    })
  }

  for (const row of related("endpoint_claims")) {
    const d = row.details
    if (!row.orderId) continue
    const detail = endpointDetails.get(String(d.endpoint_detail_id ?? ""))
    const boundary = boundaryLabel(str(detail?.details.boundary))
    const resolution = str(d.resolution_status)
    const status = resolution === "VERIFIED" ? "verified" : resolution === "OPEN" ? "claimed" : "superseded"
    const entryId = `endpoint_claims:${row.id}`
    const statedAt = date(d.recorded_at) ?? new Date(0)
    push({
      id: entryId, orderId: row.orderId, occurredAt: statedAt,
      source: "order", channel: "handover_claim", authorType: "system", authorLabel: claimSourceLabel(str(d.source_type)),
      kind: "fact", summary: `${boundary} ${humanize(String(d.field ?? "detail")).toLowerCase()}: ${oneLine(String(d.claim ?? ""), 200)}`,
      body: resolution && resolution !== "OPEN" ? `${label(resolution)}.` : "Not resolved yet.",
      status, visibility: "internal", evidence: { table: "endpoint_claims", id: row.id },
    })
    facts.push({
      id: `fact:${row.id}`, orderId: row.orderId, kind: "fact",
      subject: `${boundary} ${humanize(String(d.field ?? "detail")).toLowerCase()}`, value: String(d.claim ?? ""), status,
      sourceEntryId: entryId, statedByLabel: claimSourceLabel(str(d.source_type)), statedAt,
      supersededBy: status === "superseded" && str(d.selected_claim_id) ? `fact:${d.selected_claim_id}` : null,
    })
  }

  // Slots and promises: when was each stated, and by whom.
  const windowEvents = new Map<string, DatasetRows["events"][number]>()
  for (const event of data.events) {
    const changes = obj(event.details.changes) ?? {}
    for (const key of ["window_id", "revised_window_id", "pickup_window_id"]) {
      const id = str(changes[key])
      if (id) windowEvents.set(id, event)
    }
    if (event.targetType === "time_window") windowEvents.set(event.targetId, event)
  }
  const WINDOW_NAMES: Record<string, string> = {
    SELECTED_PICKUP_SLOT: "Pickup slot", CUSTOMER_DELIVERY_PROMISE: "Delivery promise", PICKUP_AVAILABILITY: "Pickup availability",
    REQUESTED_PICKUP_SLOT: "Requested pickup", REQUESTED_DELIVERY_SLOT: "Requested delivery", SELECTED_DELIVERY_SLOT: "Delivery slot",
  }
  for (const row of related("time_windows")) {
    const d = row.details
    if (!row.orderId) continue
    const order = orders.get(row.orderId)
    const purpose = String(d.purpose ?? "")
    const point = points.get(String(d.point_id ?? ""))
    const plan = plans.get(String(point?.details.plan_id ?? ""))
    const event = windowEvents.get(row.id)
    const source = str(d.source)
    const statedAt = event?.recordedAt
      ?? (source === "CUSTOMER" ? order?.createdAt : date(plan?.details.activated_at) ?? date(plan?.details.created_at) ?? order?.createdAt)
      ?? new Date(0)
    const customer = customers.get(order?.customerId ?? "")
    const statedBy = event ? actor(event.details.actor_id, event.details.actor_type).name
      : source === "CUSTOMER" ? `${customer?.name ?? "Customer"}, order form` : source === "OPS" ? "Ops, with the route plan" : windowSourceLabel(source)
    const selected = d.is_selected === true
    const name = WINDOW_NAMES[purpose] ?? humanize(purpose)
    const place = pointPlace(d.point_id)
    const entryId = `time_windows:${row.id}`
    const candidate = (purpose === "SELECTED_PICKUP_SLOT" || purpose === "CUSTOMER_DELIVERY_PROMISE") && !selected
    push({
      id: entryId, orderId: row.orderId, occurredAt: statedAt,
      source: source === "CUSTOMER" ? "order" : source === "SYSTEM" ? "system" : "person", channel: "time_window",
      authorType: source === "CUSTOMER" ? "customer" : source === "SYSTEM" ? "system" : "operator", authorLabel: statedBy,
      kind: "fact",
      summary: `${name}${candidate ? " (proposed, not selected)" : ""}: ${range(str(d.start_at), str(d.end_at), str(d.timezone))}${place ? ` at ${place.name}` : ""}`,
      body: source === "SYSTEM" ? "A system estimate, not a customer approval." : purpose.startsWith("REQUESTED") ? "A customer preference, not a selected slot." : null,
      status: selected ? (source === "SYSTEM" ? "claimed" : "verified") : "claimed", visibility: "internal",
      evidence: { table: "time_windows", id: row.id },
    })
    if (selected && (purpose === "SELECTED_PICKUP_SLOT" || purpose === "CUSTOMER_DELIVERY_PROMISE")) facts.push({
      id: `fact:${row.id}`, orderId: row.orderId, kind: "agreement",
      subject: `${name}${place?.role === "TRANSFER" ? " at the transfer yard" : ""}`,
      value: `${range(str(d.start_at), str(d.end_at), str(d.timezone))}${source === "SYSTEM" ? " (system estimate, customer has not approved)" : ""}`,
      status: source === "SYSTEM" ? "claimed" : "verified", sourceEntryId: entryId, statedByLabel: statedBy, statedAt, supersededBy: null,
    })
  }

  // ---- everything else from the event log -----------------------------------
  const windowZones = new Map(related("time_windows").map((row) => [row.id, str(row.details.timezone)]))
  const windowZone = (windowId: string) => windowZones.get(windowId) ?? null
  for (const event of data.events) {
    if (DUPLICATE_EVENTS.has(event.command)) continue
    const described = describeEvent(event, { actor, deskTitle, pointPlace, endpointDetails, orders, dir, windowZone, orderZone })
    if (!described) continue
    const d = event.details
    const type = str(d.actor_type)
    const source: Source = type === "operator" ? "person" : type === "agent" ? "agent" : type === "system" ? "system"
      : type === "site_contact" || type === "handoff_contact" ? (String(d.source ?? "").includes("call") ? "call" : "order") : "order"
    push({
      id: `operational_events:${event.id}`, orderId: event.orderId, occurredAt: event.recordedAt,
      source, channel: str(d.source), authorType: type, authorId: str(d.actor_id),
      authorLabel: type === "system" ? "System" : type === "driver" ? actor(d.actor_id, type).name : actor(d.actor_id, type).name,
      kind: "event", summary: described.summary, body: described.body ?? null, status: described.status ?? null,
      visibility: "internal", evidence: { table: "operational_events", id: event.id },
    })
  }

  // ---- search documents -----------------------------------------------------
  const vehicles = new Map(data.vehicles.map((vehicle) => [vehicle.id, vehicle]))
  const driversByOrder = new Map<string, Set<string>>()
  for (const row of related("work_assignments")) {
    if (!row.orderId) continue
    const name = dir.driverName(row.details.driver_id)
    if (!name) continue
    const set = driversByOrder.get(row.orderId) ?? new Set()
    set.add(name)
    driversByOrder.set(row.orderId, set)
  }
  const bodiesByOrder = new Map<string, string[]>()
  for (const entry of entries) {
    if (!entry.orderId || entry.kind !== "message" || !entry.body) continue
    const list = bodiesByOrder.get(entry.orderId) ?? []
    list.push(entry.body)
    bodiesByOrder.set(entry.orderId, list)
  }
  const search: SearchDoc[] = data.orders.map((order) => {
    const items = data.orderItems.filter((item) => item.orderId === order.id).map((item) => vehicles.get(item.vehicleId)).filter(Boolean)
    const pickup = addresses.get(String(order.details.pickup_address_id ?? ""))
    const delivery = addresses.get(String(order.details.delivery_address_id ?? ""))
    const parts = [
      order.reference, order.reference.replace("-", " "), str(order.details.customer_reference),
      customers.get(order.customerId)?.name,
      ...items.flatMap((vehicle) => [vehicle!.make, vehicle!.model, String(vehicle!.modelYear), vehicle!.registration, vehicle!.syntheticVin]),
      ...[...(driversByOrder.get(order.id) ?? [])],
      pickup?.name, pickup?.city, pickup?.country, str(pickup?.details.address_line1),
      delivery?.name, delivery?.city, delivery?.country, str(delivery?.details.address_line1),
    ]
    // Header fields, then message text after a separator, so a snippet is only shown for a match inside a message.
    const header = parts.filter(Boolean).join(" \n ")
    return { orderId: order.id, reference: order.reference, content: `${header}${SEARCH_SEPARATOR}${(bodiesByOrder.get(order.id) ?? []).join(" \n ")}` }
  })

  return { entries, facts, search }
}

type DescribeContext = {
  actor: (id: unknown, type: unknown) => { name: string; kind: string }
  deskTitle: (id: unknown) => string
  pointPlace: (pointId: unknown) => { name: string; zone: string | null; role: string | null } | null
  endpointDetails: Map<string, { details: Row }>
  orders: Map<string, { reference: string }>
  dir: Directory
  windowZone: (windowId: string) => string | null
  orderZone: (orderId: string, boundary: "pickup" | "delivery") => string | null
}

const ORDER_STATUS: Record<string, string> = {
  NEW: "new", WAITING_FOR_PICKUP: "waiting for pickup", IN_TRANSIT: "on the road", DELIVERED: "delivered",
}

const REASONS: Record<string, string> = {
  COLLECTION_VEHICLE_NOT_FOUND: "the car was not at the pickup",
  CUSTOMER_SALE_WITHDRAWN: "the sale was withdrawn",
  NO_COMPENSABLE_COST_REPORTED: "no cost to pay out",
  BLOCK_DISPATCH_SELLER_HOLD: "do not send a driver while the seller's hold stands",
  LIVE_OFFER_APPROVED_FEE_STANDS: "the approved fee stands",
  REPOST_AT_OPERATOR_APPROVED_FEE: "repost at the approved fee",
  PAYOUT_DUE: "driver fee still due",
  NO_PAYOUT: "no driver fee",
  fee_review: "fee review",
}

function reason(code: unknown): string {
  const text = str(code)
  if (!text) return ""
  return REASONS[text] ?? humanize(text).toLowerCase()
}

/** One sentence per event, in ops words. Returns null for events that add nothing a person reads. */
function describeEvent(event: DatasetRows["events"][number], ctx: DescribeContext): { summary: string; body?: string | null; status?: EntryStatus } | null {
  const d = event.details
  const changes = obj(d.changes) ?? {}
  const who = ctx.actor(d.actor_id, d.actor_type)
  const driver = who.kind === "driver" ? who.name : "the driver"
  const toState = str(d.to_state)
  const boundaryOf = (detailId: string) => boundaryLabel(str(ctx.endpointDetails.get(detailId)?.details.boundary))
  switch (event.command) {
    case "order.created": return { summary: `Order placed${who.kind === "customer" ? ` by ${who.name}` : ""}` }
    case "order.status_changed": return toState ? { summary: `Order is now ${ORDER_STATUS[toState] ?? label(toState).toLowerCase()}` } : null
    case "order.readiness_assessed": return { summary: `Readiness check: ${oneLine(String(changes.reason ?? reason(changes.decision_code)))}` }
    case "order.item_added": return { summary: "Trade-in car added to the order" }
    case "availability.confirmed": return { summary: "Pickup availability confirmed" }
    case "plan.created": return { summary: "Route plan drafted" }
    case "plan.activated": return { summary: "Route plan activated" }
    case "plan.completed": return { summary: "Route plan completed", status: "done" }
    case "plan.replaced": return { summary: `Route plan replaced${changes.reason ? `: ${String(changes.reason)}` : ""}` }
    case "plan.cancelled": return { summary: `Route plan cancelled${changes.reason_code ? `: ${reason(changes.reason_code)}` : ""}` }
    case "offer.published": {
      const fee = money(num(changes.fee_cents), str(changes.currency) ?? "EUR")
      return { summary: `Gig offered to drivers${fee ? ` at ${fee}` : ""}${changes.visibility === "DIRECTED" ? ", to one named driver" : ""}` }
    }
    case "offer.accepted": return { summary: `${who.kind === "driver" ? who.name : "A driver"} accepted the gig` }
    case "offer.withdrawn": return { summary: `Gig offer withdrawn${changes.reason ? ` (${reason(changes.reason)})` : ""}` }
    case "offer.booking_cutoff_passed": return { summary: "Gig offer passed its booking cutoff with no driver" }
    case "assignment.booked": return { summary: `${who.kind === "driver" ? who.name : "A driver"} took the gig` }
    case "assignment.started": return { summary: `${who.kind === "driver" ? who.name : "The driver"} started the gig` }
    case "assignment.completed": return { summary: `${who.kind === "driver" ? who.name : "The driver"} finished the gig`, status: "done" }
    case "assignment.cancelled": return { summary: `Driver booking cancelled${changes.reason_code ? `: ${reason(changes.reason_code)}` : ""}`, body: changes.payout_decision ? `Fee decision: ${reason(changes.payout_decision)}.` : null }
    case "vehicle.picked_up": {
      const place = ctx.pointPlace(event.targetId)
      return { summary: place?.role === "TRANSFER" ? `Car released from the transfer yard (${place.name})` : `Car picked up${place ? ` at ${place.name}` : ""}`, status: "done" }
    }
    case "vehicle.delivered": {
      const place = ctx.pointPlace(event.targetId)
      return { summary: place?.role === "TRANSFER" ? `Car dropped at the transfer yard (${place.name})` : `Car delivered${place ? ` at ${place.name}` : ""}`, status: "done" }
    }
    case "proof.require": {
      const by = str(changes.required_by)
      return { summary: `${proofLabel(str(changes.kind))} required${by ? ` by ${at(by, ctx.pointPlace(changes.point_id)?.zone)}` : ""}` }
    }
    case "travel.rebooked": return { summary: "Ferry rebooked after the missed check-in" }
    case "travel.amendment_requested": return { summary: "Asked the ferry line to move the car to a later crossing; not confirmed yet", status: "claimed" }
    case "alert.owner_assigned": return { summary: `${ctx.deskTitle(changes.owner)} owns the alert` }
    case "alert.followup_scheduled": return { summary: `Follow-up with ${humanize(String(changes.followup_with ?? "the site")).toLowerCase()} scheduled${changes.due_at ? ` for ${at(String(changes.due_at), ctx.orderZone(event.orderId, "pickup"))}` : ""}` }
    case "alert.assessed": return { summary: `Alert reviewed: ${reason(changes.decision)}` }
    case "endpoint.access_confirmed": return { summary: `${boundaryOf(event.targetId)} access confirmed`, body: str(changes.statement), status: "verified" }
    case "endpoint.contact_confirmed": return { summary: `${boundaryOf(event.targetId)} contact confirmed`, body: str(changes.statement), status: "verified" }
    case "endpoint.instruction_verified": return { summary: `${boundaryOf(event.targetId)} handover instruction verified`, body: str(changes.decision), status: "verified" }
    case "endpoint.access_reopened": return { summary: `${boundaryOf(event.targetId)} access needs checking again`, body: str(changes.reason) ? `${String(changes.reason).replace(/^./, (c) => c.toUpperCase())}.` : null }
    case "endpoint.verification_pending": return { summary: `${boundaryOf(event.targetId)} details need checking: ${humanize(String(changes.reason ?? "")).toLowerCase()}` }
    case "exposure.shown": return { summary: `Gig shown to ${ctx.dir.driverName(changes.driver_id) ?? "one driver"}` }
    case "exposure.notified": return { summary: "Driver notified about the gig" }
    case "exposure.viewed": return { summary: `${who.kind === "driver" ? who.name : "The driver"} opened the gig` }
    case "exposure.accepted": return { summary: `${who.kind === "driver" ? who.name : "The driver"} accepted the gig` }
    case "market.offer_assessed": return { summary: `Live gig offer reviewed: ${reason(changes.decision)}` }
    case "market.fee_decided": {
      const approved = money(num(changes.approved_fee_cents), "EUR")
      const requested = money(num(changes.requested_fee_cents), "EUR")
      return { summary: `Gig fee decided: ${reason(changes.decision)}${approved ? ` (${approved}${requested ? `, driver asked ${requested}` : ""})` : ""}` }
    }
    case "bundle.member_linked": {
      const first = ctx.orders.get(String(changes.first_order_id ?? ""))
      return { summary: `Same driver trip as ${first ? first.reference : "another order"}` }
    }
    case "pickup.window_revised": return { summary: `Pickup slot moved to ${range(str(changes.new_start_at), str(changes.new_end_at), ctx.windowZone(event.targetId) ?? ctx.orderZone(event.orderId, "pickup"))}`, body: changes.customer_confirmation_message_id && changes.driver_agreement_message_id ? "Customer confirmed and driver agreed." : null }
    case "delivery.window_revised": return { summary: `Delivery window moved to ${range(str(changes.new_start_at), str(changes.new_end_at), ctx.windowZone(event.targetId) ?? ctx.orderZone(event.orderId, "delivery"))}`, body: changes.customer_confirmation_message_id ? "Customer confirmed." : null }
    case "trade_in.return_window_revised": return { summary: "Trade-in return slot changed" }
    case "pickup_window.selected": return { summary: "Pickup slot selected", body: changes.customer_delivery_promise_changed === false ? "Delivery promise unchanged." : null }
    case "delivery_window.selected": return { summary: "Delivery window selected by Ops", body: changes.customer_approval_recorded === false ? "No customer approval recorded." : null }
    case "delivery.promise_recorded": return { summary: "Customer set the delivery promise" }
    case "delivery.delay_reported": return { summary: "Driver reported a delay" }
    case "delivery.promise_revised": return { summary: `Customer ${changes.customer_approved ? "approved" : "proposed"} a new delivery window` }
    case "delivery.late_outcome_recorded": return { summary: `Delivered after the promise${changes.actual_delivery_at ? `, at ${at(String(changes.actual_delivery_at), ctx.orderZone(event.orderId, "delivery"))}` : ""}` }
    case "support.request_received": return { summary: `Customer request: ${reason(changes.reason_code)}` }
    case "support.answer_recorded": return { summary: "Support answered and closed the conversation", status: "done" }
    case "support.no_change_recorded": return { summary: "Support answered; nothing on the order changed", status: "done" }
    case "order.cancellation_confirmed": return { summary: "Customer confirmed the cancellation" }
    case "order.cancelled": return { summary: `Order cancelled${changes.reason_code ? `: ${reason(changes.reason_code)}` : ""}`, status: "done" }
    case "order.cancellation_cost_reviewed": return { summary: `Cancellation costs reviewed: ${reason(changes.decision)}` }
    case "pickup.vehicle_not_found": return { summary: "The site confirmed the car is not there", status: "verified" }
    default: return { summary: `${humanize(event.command)}${toState ? `: ${label(toState).toLowerCase()}` : ""}` }
  }
}
