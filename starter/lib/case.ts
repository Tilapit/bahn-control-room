// The compiled case file. One shape, used by the agents (as their reading of an
// order) and by the order screen. Everything in it comes from records and
// carries a source entry and a time; nothing here is written by an LLM.

import { and, asc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm"
import { db } from "./db"
import { now as clockNow } from "./clock"
import { Directory } from "./present/actors"
import { chosenWindows, latestTracking, milestones } from "./present/attention"
import {
  type Bundle, type RelatedRow, activePoints, finalDeliveryPoint, journeyPlan, num, obj, originPickupPoint, rows, str, strings,
} from "./present/bundle"
import { label } from "./present/labels"
import {
  addresses, alerts, cards, conversations, customers, decisions, drivers, facts as factsTable, operationalEvents, orderItems,
  orders, relatedRecords, searchDocuments, sites, timelineEntries, vehicles,
} from "./schema"
import type { ExecutedEffect } from "./schema"
import { SEARCH_SEPARATOR } from "./timeline/build"
import { chipLabel, chipWho, sourceLabel } from "./timeline/sources"
import { clock } from "./time"
import { documentLabel, incidentLabel, money, signalLabel, taskLabel, travelLabel } from "./words"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceRef = {
  /** Timeline entry that holds the source, when there is one. */
  entryId: string | null
  /** "Kasper Kovelund, driver chat", "Site profile, Marvellin Hamburg". */
  label: string
  /** Short form for a chip: "Driver", "Customer email", "Quote, not booked". */
  chip: string
  at: string | null
}

export type CasePlace = {
  name: string
  city: string
  country: string
  zone: string | null
  kind: "dealer" | "private" | "yard" | "business" | "other"
  addressLine: string | null
}

export type StageKey = "intake" | "ready" | "finding_driver" | "driver_booked" | "moving" | "at_transfer" | "delivered" | "cancelled"

export type KeyTime = {
  key: "pickup_slot" | "pickup_planned" | "picked_up" | "delivery_promise" | "ferry_cutoff" | "eta" | "delivered" | "driver_travel"
  label: string
  start: string
  end: string | null
  zone: string | null
  /** The city the time belongs to: "Hamburg". Times are local to it. */
  place: string | null
  note: string | null
  source: SourceRef
}

export type CaseFact = {
  id: string
  kind: "fact" | "agreement"
  subject: string
  value: string
  status: "claimed" | "verified" | "superseded"
  /** A pre-handover detail after the handover happened: kept, but no longer current. */
  historical: boolean
  source: SourceRef
}

export type TimelineItem = {
  id: string
  orderId: string | null
  at: string
  receivedAt: string | null
  source: string
  sourceLabel: string
  chip: string
  channel: string | null
  authorType: string | null
  authorLabel: string | null
  kind: string
  summary: string
  body: string | null
  status: string | null
  visibility: string
  evidence: { table: string; id: string }
  language: string | null
}

export type CaseFile = {
  asOf: string
  order: {
    id: string
    reference: string
    customerReference: string | null
    stage: { key: StageKey; label: string }
    customer: { id: string; name: string; tier: string | null }
    car: { make: string; model: string; year: number | null; registration: string | null; vin: string | null; fuel: string | null; label: string; image: string | null }
    tradeIn: { label: string; registration: string | null } | null
    route: { from: CasePlace | null; to: CasePlace | null; via: CasePlace | null; kind: "domestic" | "import"; distanceKm: number | null; ferry: boolean }
    driver: { id: string; name: string; home: string | null; state: "booked" | "driving" | "finished" } | null
    otherDrivers: { name: string; state: string }[]
    createdAt: string
    pickedUpAt: string | null
    deliveredAt: string | null
    cancelledAt: string | null
  }
  keyTimes: KeyTime[]
  facts: CaseFact[]
  open: {
    alerts: { id: string; signal: string; label: string; severity: string; taken: boolean; owner: string | null; summary: string; at: string; conversationId: string | null; source: SourceRef }[]
    tasks: { id: string; label: string; owner: string | null; dueAt: string | null; summary: string | null; nextAction: string | null; source: SourceRef }[]
    incidents: { id: string; label: string; status: string; owner: string | null; notes: string | null; source: SourceRef }[]
    cards: { id: string; headline: string; severity: string; createdAt: string; origin: string }[]
    proposals: { id: string; summary: string; state: "waiting for review" | "approved, not carried out yet" | "failed"; detail: string | null; agent: string; source: SourceRef }[]
    claims: { id: string; text: string; source: SourceRef }[]
    conversations: {
      id: string; channel: string; topic: string; waitingOn: string | null
      firstInbound: { text: string; author: string; source: SourceRef } | null
      lastInbound: { text: string; author: string; source: SourceRef } | null
      unanswered: boolean
    }[]
    /** Open support inbox threads that name this order: confirmed links, or only a possible match. */
    supportInbox: { threadId: string; linked: boolean; topic: string; basis: string | null; waitingOn: string | null; source: SourceRef }[]
    documents: { label: string; state: string; source: SourceRef }[]
  }
  plan: {
    stops: (CasePlace & { role: "pickup" | "transfer" | "delivery" })[]
    legs: { from: string; to: string; mode: string; distanceKm: number | null; status: string; driver: string | null }[]
    offer: { state: string; fee: string | null; at: string | null } | null
    bookings: { id: string; kind: string; summary: string; state: "booked" | "lost"; departureAt: string | null; cutoffAt: string | null; zone: string | null; source: SourceRef }[]
    quotes: { id: string; kind: string; summary: string; state: "quote" | "sold out"; checkedAt: string; source: SourceRef }[]
    lastPosition: { at: string; receivedAt: string | null; kmToGo: number | null; eta: string | null; quality: string; source: SourceRef } | null
    /** Planning range from the pickup city to the ferry terminal. Not live, not a position. */
    terminalDrive: { from: string; terminal: string; city: string; km: number | null; minutesLow: number | null; minutesHigh: number | null; source: SourceRef } | null
  }
  timeline: TimelineItem[]
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type OrderRow = typeof orders.$inferSelect
type EntryRow = typeof timelineEntries.$inferSelect

const iso = (value: Date | string | null | undefined): string => value instanceof Date ? value.toISOString() : value ? String(value) : ""

async function resolveOrderId(idOrReference: string): Promise<string | null> {
  const [row] = await db.select({ id: orders.id }).from(orders)
    .where(or(eq(orders.id, idOrReference), eq(orders.reference, idOrReference.toUpperCase()))).limit(1)
  return row?.id ?? null
}

/** Everything the case files of these orders read, in one pass per table. */
async function loadBundles(orderIds: string[] | null) {
  const orderFilter = orderIds ? inArray(orders.id, orderIds) : undefined
  const [orderRows, customerRows, siteRows, addressRows, driverRows, shared, endpointRows] = await Promise.all([
    db.select().from(orders).where(orderFilter).orderBy(asc(orders.reference)),
    db.select().from(customers),
    db.select().from(sites),
    db.select().from(addresses),
    db.select().from(drivers),
    db.select().from(relatedRecords).where(inArray(relatedRecords.collection, ["operators", "agents", "support_inbox_threads", "ferry_terminals", "terminal_road_estimates"])),
    db.select().from(relatedRecords).where(eq(relatedRecords.collection, "order_endpoint_details")),
  ])
  const ids = orderRows.map((order) => order.id)
  if (!ids.length) return { bundles: [] as Bundle[], orderRows, shared, driverRows, dir: null as Directory | null }
  const [itemRows, alertRows, threadRows, eventRows, relatedRows] = await Promise.all([
    db.select({ item: orderItems, vehicle: vehicles }).from(orderItems).innerJoin(vehicles, eq(orderItems.vehicleId, vehicles.id)).where(inArray(orderItems.orderId, ids)),
    db.select().from(alerts).where(inArray(alerts.orderId, ids)),
    db.select().from(conversations),
    db.select().from(operationalEvents).where(and(inArray(operationalEvents.orderId, ids), inArray(operationalEvents.command, ["vehicle.picked_up", "vehicle.delivered"]))),
    db.select().from(relatedRecords).where(inArray(relatedRecords.orderId, ids)),
  ])
  const dir = new Directory({
    drivers: driverRows,
    operators: shared.filter((row) => row.collection === "operators").map((row) => ({ id: row.id, ...row.details })),
    agents: shared.filter((row) => row.collection === "agents").map((row) => ({ id: row.id, ...row.details })),
    customers: customerRows,
    sites: siteRows,
    endpointDetails: endpointRows.map((row) => ({ id: row.id, ...row.details })),
  })
  const places = new Map(addressRows.map((row) => [row.id, { id: row.id, name: row.name, city: row.city, country: row.country, managedSiteId: row.managedSiteId, details: row.details }]))
  const siteMap = new Map(siteRows.map((row) => [row.id, { id: row.id, name: row.name, city: row.city, country: row.country, kind: row.kind, details: row.details }]))
  const customerMap = new Map(customerRows.map((row) => [row.id, row]))
  const inbox = shared.filter((row) => row.collection === "support_inbox_threads").map((row) => ({ id: row.id, details: row.details }))

  const bundles: Bundle[] = orderRows.map((order) => {
    const related: Record<string, RelatedRow[]> = {}
    for (const row of relatedRows) if (row.orderId === order.id) (related[row.collection] ??= []).push({ id: row.id, details: row.details })
    // A thread filed on one order can concern another; it belongs to both case files.
    const threads = threadRows.filter((thread) => thread.orderId === order.id || strings(thread.details.related_order_ids).includes(order.id))
    const customer = customerMap.get(order.customerId)
    return {
      snapshotAt: null,
      order: {
        id: order.id, reference: order.reference, lane: order.displayLane, status: order.status, routeKind: order.routeKind,
        createdAt: iso(order.createdAt), updatedAt: iso(order.updatedAt), details: order.details,
        pickupAddressId: order.pickupAddressId, deliveryAddressId: order.deliveryAddressId,
        pickupSiteId: order.pickupSiteId, deliverySiteId: order.deliverySiteId,
      },
      customer: { id: order.customerId, name: customer?.name ?? "Unknown customer", tier: customer?.accountTier ?? null, country: customer?.country ?? null },
      items: itemRows.filter((row) => row.item.orderId === order.id).map(({ item, vehicle }) => ({
        id: item.id, role: item.role, details: item.details,
        vehicle: { id: vehicle.id, make: vehicle.make, model: vehicle.model, year: vehicle.modelYear, fuel: vehicle.fuel, registration: vehicle.registration, vin: vehicle.syntheticVin },
      })),
      alerts: alertRows.filter((alert) => alert.orderId === order.id).map((alert) => ({
        id: alert.id, status: alert.status, severity: alert.severity, signal: alert.signal, summary: alert.summary, triggeredAt: iso(alert.triggeredAt), details: alert.details,
      })),
      conversations: threads.map((thread) => ({
        id: thread.id, orderId: thread.orderId, status: thread.status, category: thread.category, channel: thread.channel, updatedAt: iso(thread.updatedAt), details: thread.details,
      })),
      messages: [],
      events: eventRows.filter((event) => event.orderId === order.id).map((event) => ({
        id: event.id, orderId: event.orderId, command: event.command, targetType: event.targetType, targetId: event.targetId, recordedAt: iso(event.recordedAt), details: event.details,
      })),
      related,
      places,
      sites: siteMap,
      dir,
      inboxThreads: inbox.filter((thread) => strings(thread.details.candidate_order_ids).includes(order.id) || strings(thread.details.linked_order_ids).includes(order.id)),
      bundleOrderRefs: {},
    }
  })
  return { bundles, orderRows, shared, driverRows, dir }
}

function toItem(entry: EntryRow): TimelineItem {
  return {
    id: entry.id, orderId: entry.orderId, at: iso(entry.occurredAt), receivedAt: entry.receivedAt ? iso(entry.receivedAt) : null,
    source: entry.source, sourceLabel: sourceLabel(entry.source, entry.channel), chip: chipLabel(entry),
    channel: entry.channel, authorType: entry.authorType, authorLabel: entry.authorLabel, kind: entry.kind,
    summary: entry.summary, body: entry.body, status: entry.status, visibility: entry.visibility,
    evidence: entry.evidence, language: entry.language,
  }
}

// ---------------------------------------------------------------------------
// Compiling one case
// ---------------------------------------------------------------------------

const STAGE_LABEL: Record<StageKey, string> = {
  intake: "New order, being prepared",
  ready: "Ready to offer to drivers",
  finding_driver: "Looking for a driver",
  driver_booked: "Driver booked, waiting for pickup",
  moving: "On the road",
  at_transfer: "At the transfer yard",
  delivered: "Delivered",
  cancelled: "Cancelled",
}

function placeOf(bundle: Bundle, addressId: unknown): CasePlace | null {
  const address = bundle.places.get(String(addressId ?? ""))
  if (!address) return null
  const kind = str(address.details.kind)
  return {
    name: address.name === "Private handoff" ? "Private address" : address.name,
    city: address.city, country: address.country, zone: str(address.details.timezone),
    kind: kind === "DEALERSHIP" || kind === "SOURCE_DEALER" ? "dealer" : kind === "PRIVATE_HOME" ? "private" : kind === "TRANSFER_YARD" ? "yard" : kind ? "business" : "other",
    addressLine: str(address.details.address_line1),
  }
}

function carImage(make: string, model: string): string | null {
  const slug = `${make}-${model}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
  return `/car-images/${slug}.webp`
}

type CompileInput = {
  bundle: Bundle
  /** Message id to conversation id. */
  messageThreads: Map<string, string>
  entries: EntryRow[]
  factRows: (typeof factsTable.$inferSelect)[]
  openCards: { id: string; headline: string; severity: string; createdAt: Date; origin: string }[]
  inboxEntries: EntryRow[]
  asOf: Date
  terminals: Map<string, RelatedRow>
  roadEstimates: RelatedRow[]
  /** What the Executor did on this order after a person approved it. */
  effects: ExecutedEffect[]
}

function compile({ bundle, messageThreads, entries, factRows, openCards, inboxEntries, asOf, terminals, roadEstimates, effects }: CompileInput): CaseFile {
  const { dir } = bundle
  const entryById = new Map(entries.map((entry) => [entry.id, entry]))
  const ref = (entryId: string, fallbackLabel?: string): SourceRef => {
    const entry = entryById.get(entryId)
    if (!entry) return { entryId: null, label: fallbackLabel ?? "Order record", chip: fallbackLabel ?? "Order record", at: null }
    const who = entry.authorLabel ?? chipWho(entry)
    const labelText = entry.kind === "message" ? `${who}, ${sourceLabel(entry.source, entry.channel).toLowerCase()}` : who
    return { entryId: entry.id, label: labelText, chip: chipLabel(entry), at: iso(entry.occurredAt) }
  }

  const cityZone = (city: unknown): string | null => {
    for (const place of bundle.places.values()) if (place.city === city && str(place.details.timezone)) return str(place.details.timezone)
    return null
  }

  // ---- header ---------------------------------------------------------------
  const primary = bundle.items.find((item) => item.role === "PRIMARY") ?? bundle.items[0]
  const tradeIn = bundle.items.find((item) => item.role === "TRADE_IN")
  const car = primary?.vehicle
  const pickup = placeOf(bundle, bundle.order.pickupAddressId)
  const delivery = placeOf(bundle, bundle.order.deliveryAddressId)
  const points = activePoints(bundle)
  const transferPoint = points.find((point) => point.details.role === "TRANSFER")
  const via = transferPoint ? placeOf(bundle, transferPoint.details.address_id) : null
  const { plan } = journeyPlan(bundle)
  const segments = rows(bundle, "transport_segments").filter((segment) => !plan || segment.details.plan_id === plan.id)
  const { pickedUpAt, deliveredAt } = milestones(bundle)
  const cancelledAt = str(bundle.order.details.cancelled_at)
  const assignments = rows(bundle, "work_assignments")
  const live = assignments.filter((row) => ["ASSIGNED", "IN_PROGRESS"].includes(String(row.details.status)))
  const primaryAssignment = live.find((row) => strings(row.details.segment_ids).some((id) => segments.some((segment) => segment.id === id && segment.details.order_item_id === primary?.id)))
    ?? live[0] ?? assignments.filter((row) => row.details.status === "COMPLETED").pop() ?? null
  const offers = rows(bundle, "market_offers")
  const liveOffer = offers.find((offer) => offer.details.status === "PUBLISHED") ?? null
  const droppedAtTransfer = transferPoint && bundle.events.some((event) => event.command === "vehicle.delivered" && event.targetId === transferPoint.id)
  const releasedFromTransfer = transferPoint && bundle.events.some((event) => event.command === "vehicle.picked_up" && event.targetId === transferPoint.id)

  let stage: StageKey
  if (cancelledAt) stage = "cancelled"
  else if (deliveredAt) stage = "delivered"
  else if (droppedAtTransfer && !releasedFromTransfer) stage = "at_transfer"
  else if (pickedUpAt) stage = "moving"
  else if (live.length) stage = "driver_booked"
  else if (liveOffer) stage = "finding_driver"
  else if (plan && bundle.order.details.readiness_status === "CONFIRMED") stage = "ready"
  else stage = "intake"
  const tradeInOpen = !!tradeIn && segments.some((segment) => segment.details.order_item_id === tradeIn.id && segment.details.status !== "COMPLETED")
  const stageLabel = stage === "delivered" && tradeInOpen ? "Delivered; trade-in still moving" : STAGE_LABEL[stage]

  const driverId = str(primaryAssignment?.details.driver_id)
  const driverState = primaryAssignment?.details.status === "IN_PROGRESS" ? "driving" : primaryAssignment?.details.status === "COMPLETED" ? "finished" : "booked"
  const otherDrivers = assignments
    .filter((row) => row !== primaryAssignment && row.details.driver_id)
    .map((row) => ({ name: dir.driverName(row.details.driver_id) ?? "Driver", state: label(str(row.details.status)).toLowerCase() }))

  // ---- key times -------------------------------------------------------------
  const windows = chosenWindows(bundle)
  const windowRow = (purpose: string, pointId: string | null | undefined) => rows(bundle, "time_windows")
    .find((row) => row.details.purpose === purpose && row.details.is_selected === true && (!pointId || row.details.point_id === pointId))
  const origin = originPickupPoint(bundle)
  const final = finalDeliveryPoint(bundle)
  const keyTimes: KeyTime[] = []
  if (pickedUpAt) {
    const event = bundle.events.find((e) => e.command === "vehicle.picked_up" && e.targetId === origin?.id)
    keyTimes.push({ key: "picked_up", label: "Picked up", start: pickedUpAt, end: null, zone: pickup?.zone ?? null, place: pickup?.city ?? null, note: null, source: ref(`operational_events:${event?.id}`, "Driver app") })
  } else if (windows.pickupSlot) {
    const row = windowRow("SELECTED_PICKUP_SLOT", origin?.id)
    keyTimes.push({
      key: "pickup_slot", label: "Pickup slot", start: windows.pickupSlot.start, end: windows.pickupSlot.end, zone: windows.pickupSlot.zone, place: pickup?.city ?? null,
      note: null, source: ref(`time_windows:${row?.id}`, "Order record"),
    })
  } else {
    const candidate = rows(bundle, "time_windows").find((row) => row.details.purpose === "SELECTED_PICKUP_SLOT" && (!origin || row.details.point_id === origin.id))
      ?? rows(bundle, "time_windows").find((row) => row.details.purpose === "REQUESTED_PICKUP_SLOT")
    if (candidate) keyTimes.push({
      key: "pickup_planned", label: "Planned pickup", start: String(candidate.details.start_at), end: str(candidate.details.end_at), zone: str(candidate.details.timezone), place: pickup?.city ?? null,
      note: "Not confirmed yet", source: ref(`time_windows:${candidate.id}`),
    })
  }
  if (stage === "at_transfer" && transferPoint) {
    const row = rows(bundle, "time_windows").find((candidate) => candidate.details.point_id === transferPoint.id && candidate.details.is_selected === true)
    if (row) keyTimes.push({
      key: "pickup_slot", label: "Yard release slot", start: String(row.details.start_at), end: str(row.details.end_at), zone: str(row.details.timezone), place: via?.city ?? null,
      note: via ? `${via.name}, ${via.city}` : null, source: ref(`time_windows:${row.id}`),
    })
  }
  // Booked driver travel that has not happened yet, while the car still waits for pickup.
  if (!pickedUpAt && !cancelledAt) {
    for (const reservation of rows(bundle, "travel_reservations")) {
      const d = reservation.details
      if (d.kind === "FERRY" || d.kind === "HOTEL" || d.status !== "BOOKED") continue
      const departure = str(d.departure_at)
      if (!departure || new Date(departure) < asOf) continue
      keyTimes.push({
        // A city outside the address records falls back to the pickup's zone; positioning travel heads there.
        key: "driver_travel", label: `Driver's ${travelLabel(str(d.kind)).toLowerCase()}`, start: departure, end: str(d.expected_arrival_at),
        zone: cityZone(d.from_city) ?? pickup?.zone ?? null, place: str(d.from_city),
        note: `${str(d.from_city) ?? "?"} to ${str(d.to_city) ?? "?"}`, source: ref(`travel_reservations:${reservation.id}`),
      })
    }
  }
  for (const reservation of rows(bundle, "travel_reservations")) {
    const d = reservation.details
    if (d.kind !== "FERRY" || d.status !== "BOOKED" || str(d.cancelled_at)) continue
    const cutoff = str(d.check_in_cutoff_at)
    if (!cutoff || (deliveredAt && new Date(cutoff) < new Date(deliveredAt))) continue
    if (new Date(cutoff).getTime() < asOf.getTime() - 24 * 3600_000) continue
    const terminal = terminals.get(String(d.origin_terminal_id ?? ""))
    keyTimes.push({
      key: "ferry_cutoff", label: "Ferry check-in closes", start: cutoff, end: null, zone: str(terminal?.details.timezone), place: str(terminal?.details.city),
      note: `${String(d.origin_terminal ?? "Terminal").replace(" Vehicle Terminal", "")}, sailing ${clock(d.departure_at, str(terminal?.details.timezone))}`,
      source: ref(`travel_reservations:${reservation.id}`),
    })
  }
  const { direct } = latestTracking(bundle)
  if (stage === "moving" && direct?.eta) {
    const obs = rows(bundle, "tracking_observations").find((row) => row.details.observed_at === direct.observedAt)
    keyTimes.push({
      key: "eta", label: "Driver app ETA", start: direct.eta, end: null, zone: delivery?.zone ?? null, place: delivery?.city ?? null,
      note: `${direct.quality === "STALE" ? "Stale" : "Coarse"} estimate, not a promise`, source: ref(`tracking_observations:${obs?.id}`, "GPS"),
    })
  }
  if (windows.promise) {
    const row = windowRow("CUSTOMER_DELIVERY_PROMISE", final?.id)
    keyTimes.push({
      key: "delivery_promise", label: "Delivery promise", start: windows.promise.start, end: windows.promise.end, zone: windows.promise.zone, place: delivery?.city ?? null,
      note: windows.promise.source === "SYSTEM" ? "System estimate; the customer has not approved it" : null,
      source: ref(`time_windows:${row?.id}`),
    })
  } else {
    const candidate = rows(bundle, "time_windows").find((row) => row.details.purpose === "CUSTOMER_DELIVERY_PROMISE" || row.details.purpose === "REQUESTED_DELIVERY_SLOT")
    if (candidate && !deliveredAt) keyTimes.push({
      key: "delivery_promise", label: "Requested delivery", start: String(candidate.details.start_at), end: str(candidate.details.end_at),
      zone: str(candidate.details.timezone), place: delivery?.city ?? null, note: "Not confirmed yet", source: ref(`time_windows:${candidate.id}`),
    })
  }
  if (deliveredAt) {
    const event = bundle.events.find((e) => e.command === "vehicle.delivered" && e.targetId === final?.id)
    keyTimes.push({ key: "delivered", label: "Delivered", start: deliveredAt, end: null, zone: delivery?.zone ?? null, place: delivery?.city ?? null, note: null, source: ref(`operational_events:${event?.id}`, "Driver app") })
  }

  // A time a person changed through an approved card replaces the recorded one.
  for (const window of effects.flatMap((effect) => effect.windows)) {
    const index = keyTimes.findIndex((time) => time.key === window.key || (window.key === "pickup_slot" && time.key === "pickup_planned"))
    const changed: KeyTime = {
      key: window.key, label: window.key === "pickup_slot" ? "Pickup slot" : "Delivery promise", start: window.start, end: window.end, zone: window.zone,
      place: window.place, note: "Changed by Ops through the control room", source: ref(window.entryId, "Ops"),
    }
    if (index >= 0) keyTimes[index] = changed
    else keyTimes.push(changed)
  }
  for (const booking of effects.flatMap((effect) => effect.bookings)) {
    if (booking.kind !== "Ferry" || !booking.cutoffAt) continue
    keyTimes.push({ key: "ferry_cutoff", label: "Ferry check-in closes", start: booking.cutoffAt, end: null, zone: booking.zone, place: "Hamburg", note: "Booked through the control room (simulated)", source: ref(booking.entryId, "Executor") })
  }

  // ---- facts ------------------------------------------------------------------
  const historicalBoundary = (subject: string) => subject.includes("transfer yard")
    ? !!releasedFromTransfer
    : (!!pickedUpAt && subject.startsWith("Pickup")) || (!!deliveredAt && (subject.startsWith("Delivery") || subject.startsWith("Receiving")))
  const factList: CaseFact[] = factRows
    .filter((row) => row.status !== "superseded")
    .map((row) => ({
      id: row.id, kind: row.kind as CaseFact["kind"], subject: row.subject, value: row.value, status: row.status as CaseFact["status"],
      historical: historicalBoundary(row.subject),
      source: { entryId: row.sourceEntryId, label: row.statedByLabel, chip: row.statedByLabel, at: iso(row.statedAt) },
    }))
    .sort((a, b) => Number(a.historical) - Number(b.historical) || (a.kind === b.kind ? String(b.source.at).localeCompare(String(a.source.at)) : a.kind === "agreement" ? -1 : 1))

  // ---- open items ---------------------------------------------------------------
  // Signals a person dealt with through an approved card are no longer open, even though the dataset row is.
  const handled = new Set(effects.flatMap((effect) => effect.handled ?? []).map((item) => `${item.kind}:${item.id}`))
  const openAlerts = bundle.alerts.filter((alert) => (alert.status === "OPEN" || alert.status === "ACKNOWLEDGED") && !handled.has(`alert:${alert.id}`)).map((alert) => ({
    id: alert.id, signal: alert.signal, label: signalLabel(alert.signal), severity: alert.severity, taken: alert.status === "ACKNOWLEDGED",
    owner: dir.title(alert.details.owner), summary: alert.summary, at: alert.triggeredAt,
    conversationId: str(alert.details.conversation_id), source: ref(`alerts:${alert.id}`),
  })).sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.at.localeCompare(a.at))
  const tasks = rows(bundle, "work_items").filter((row) => ["OPEN", "NEEDS_EXTERNAL_INPUT"].includes(String(row.details.status))).map((row) => ({
    id: row.id, label: taskLabel(str(row.details.kind)), owner: dir.title(row.details.owner), dueAt: str(row.details.due_at),
    summary: str(row.details.summary), nextAction: str(row.details.next_action), source: ref(`work_items:${row.id}`),
  }))
  const incidents = rows(bundle, "incidents").filter((row) => !str(row.details.resolved_at) && !handled.has(`incident:${row.id}`)).map((row) => ({
    id: row.id, label: incidentLabel(str(row.details.kind)), status: label(str(row.details.status)).toLowerCase(), owner: dir.title(row.details.owner),
    notes: entryById.get(`incidents:${row.id}`)?.body ?? null, source: ref(`incidents:${row.id}`),
  }))
  const proposals = rows(bundle, "agent_proposals").filter((row) => ["PENDING_REVIEW", "APPROVED_AWAITING_EXECUTION", "FAILED"].includes(String(row.details.status)) && !handled.has(`proposal:${row.id}`)).map((row) => {
    const status = String(row.details.status)
    const state = status === "PENDING_REVIEW" ? "waiting for review" as const : status === "FAILED" ? "failed" as const : "approved, not carried out yet" as const
    return {
      id: row.id, summary: String(row.details.summary ?? ""), state,
      detail: status === "FAILED" ? str(obj(row.details.execution)?.error) : str(obj(row.details.review)?.decision_note) ?? str(row.details.rationale),
      agent: dir.title(row.details.proposed_by_agent_id) ?? "Agent", source: ref(`agent_proposals:${row.id}`),
    }
  })
  const claims = rows(bundle, "endpoint_claims").filter((row) => row.details.resolution_status === "OPEN").map((row) => ({
    id: row.id, text: String(row.details.claim ?? ""), source: ref(`endpoint_claims:${row.id}`),
  }))
  const INBOUND = new Set(["driver", "customer", "site_contact", "handoff_contact"])
  const openThreads = bundle.conversations.filter((thread) => thread.status === "OPEN").map((thread) => {
    const threadEntries = entries.filter((entry) => entry.kind === "message" && entry.evidence.table === "messages" && entry.visibility === "public"
      && entry.channel !== "internal_note" && messageThreads.get(entry.evidence.id) === thread.id)
    const last = threadEntries[threadEntries.length - 1]
    const lastInboundEntry = [...threadEntries].reverse().find((entry) => INBOUND.has(String(entry.authorType)))
    const firstInboundEntry = threadEntries.find((entry) => INBOUND.has(String(entry.authorType)))
    // A reply sent live (by Ops through a card, or by an agent) in the same channel answers it.
    const answeredLive = !!lastInboundEntry && entries.some((entry) => entry.origin === "live" && entry.kind === "message" && entry.source === lastInboundEntry.source
      && ["agent", "operator"].includes(String(entry.authorType)) && entry.occurredAt > lastInboundEntry.occurredAt)
    return {
      id: thread.id, channel: label(thread.channel), topic: label(thread.category),
      waitingOn: str(thread.details.waiting_on) ? label(str(thread.details.waiting_on)).toLowerCase() : null,
      firstInbound: firstInboundEntry ? { text: firstInboundEntry.summary, author: firstInboundEntry.authorLabel ?? "Unknown", source: ref(firstInboundEntry.id) } : null,
      lastInbound: lastInboundEntry ? { text: lastInboundEntry.summary, author: lastInboundEntry.authorLabel ?? "Unknown", source: ref(lastInboundEntry.id) } : null,
      unanswered: !!last && INBOUND.has(String(last.authorType)) && !answeredLive,
    }
  })
  const supportInbox = bundle.inboxThreads
    .filter((thread) => thread.details.status === "OPEN")
    .map((thread) => {
      const linked = strings(thread.details.linked_order_ids).includes(bundle.order.id)
      const basisId = str(thread.details.candidate_basis_message_id)
      const first = (linked ? entries : inboxEntries).find((entry) => entry.evidence.table === "support_inbox_messages" && entry.evidence.id === basisId)
        ?? (linked ? entries : inboxEntries).find((entry) => entry.evidence.table === "support_inbox_messages")
      return {
        threadId: thread.id, linked, topic: label(str(thread.details.category)), basis: str(thread.details.candidate_basis),
        waitingOn: str(thread.details.waiting_on) ? label(str(thread.details.waiting_on)).toLowerCase() : null,
        source: first
          ? { entryId: first.id, label: `${first.authorLabel ?? "Sender"}, ${sourceLabel(first.source, first.channel).toLowerCase()}`, chip: chipLabel(first), at: iso(first.occurredAt) }
          : { entryId: null, label: "Support inbox", chip: "Support inbox", at: str(thread.details.opened_at) },
      }
    })
  const documents = rows(bundle, "documents").filter((row) => ["MISSING", "REQUESTED"].includes(String(row.details.status))).map((row) => ({
    label: documentLabel(str(row.details.kind)), state: label(str(row.details.status)).toLowerCase(), source: ref(`documents:${row.id}`),
  }))

  // ---- plan, bookings, quotes ---------------------------------------------------
  const stops = points.map((point) => {
    const place = placeOf(bundle, point.details.address_id)
    const role = point.details.role === "TRANSFER" ? "transfer" as const : point.details.role === "DELIVERY" ? "delivery" as const : "pickup" as const
    return place ? { ...place, role } : null
  }).filter((stop): stop is NonNullable<typeof stop> => !!stop)
  const pointName = (pointId: unknown) => {
    const point = points.find((candidate) => candidate.id === pointId)
    const place = point ? placeOf(bundle, point.details.address_id) : null
    return place ? (place.kind === "private" ? `${place.city} (private)` : `${place.name}, ${place.city}`) : "?"
  }
  const legs = segments.map((segment) => {
    const assignment = assignments.find((row) => strings(row.details.segment_ids).includes(segment.id) && row.details.status !== "CANCELLED")
    const item = bundle.items.find((candidate) => candidate.id === segment.details.order_item_id)
    return {
      from: pointName(segment.details.from_point_id), to: pointName(segment.details.to_point_id),
      mode: `${segment.details.transport_mode === "DRIVE_WITH_FERRY" ? "Drive with ferry" : "Drive"}${item?.role === "TRADE_IN" ? " (trade-in)" : ""}`,
      distanceKm: num(segment.details.distance_km), status: label(str(segment.details.status)).toLowerCase(),
      driver: assignment ? dir.driverName(assignment.details.driver_id) : null,
    }
  })
  const offer = liveOffer ?? offers.filter((row) => row.details.status === "ACCEPTED").pop() ?? null
  const bookings = rows(bundle, "travel_reservations").map((row) => {
    const d = row.details
    const lost = d.status !== "BOOKED" || !!str(d.cancelled_at)
    const terminal = terminals.get(String(d.origin_terminal_id ?? ""))
    return {
      id: row.id, kind: travelLabel(str(d.kind)), summary: entryById.get(`travel_reservations:${row.id}`)?.summary ?? travelLabel(str(d.kind)),
      state: lost ? "lost" as const : "booked" as const, departureAt: str(d.departure_at), cutoffAt: str(d.check_in_cutoff_at),
      zone: str(terminal?.details.timezone), source: ref(`travel_reservations:${row.id}`),
    }
  })
  // Simulated bookings made by the Executor after a person approved them.
  for (const booking of effects.flatMap((effect) => effect.bookings)) {
    bookings.push({ id: booking.entryId, kind: booking.kind, summary: booking.summary, state: "booked", departureAt: booking.departureAt, cutoffAt: booking.cutoffAt, zone: booking.zone, source: ref(booking.entryId, "Executor") })
  }
  bookings.sort((a, b) => String(a.departureAt).localeCompare(String(b.departureAt)))
  const quotes = rows(bundle, "travel_options").map((row) => ({
    id: row.id, kind: travelLabel(str(row.details.kind)), summary: entryById.get(`travel_options:${row.id}`)?.summary ?? "Quote",
    state: row.details.status === "SOLD_OUT" ? "sold out" as const : "quote" as const, checkedAt: String(row.details.checked_at ?? ""),
    source: ref(`travel_options:${row.id}`),
  }))
  const lastObservation = rows(bundle, "tracking_observations")
    .sort((a, b) => String(b.details.observed_at).localeCompare(String(a.details.observed_at)))[0]
  const lastPosition = lastObservation ? {
    at: String(lastObservation.details.observed_at), receivedAt: str(lastObservation.details.received_at),
    kmToGo: num(lastObservation.details.distance_remaining_km), eta: str(lastObservation.details.estimated_delivery_at),
    quality: String(lastObservation.details.location_quality ?? "COARSE").toLowerCase(), source: ref(`tracking_observations:${lastObservation.id}`, "GPS"),
  } : null

  // The drive to the terminal of the booked (or else quoted) ferry, from the planning matrix.
  const ferryRow = rows(bundle, "travel_reservations").find((row) => row.details.kind === "FERRY" && row.details.status === "BOOKED")
  const terminalId = str(ferryRow?.details.origin_terminal_id) ?? (rows(bundle, "travel_options").some((row) => row.details.kind === "FERRY" && String(row.details.from_city ?? "").startsWith("West Baltic")) ? "terminal-west-baltic" : null)
  const estimate = terminalId ? roadEstimates.find((row) => row.details.to_terminal_id === terminalId && row.details.from_city === pickup?.city) : undefined
  const terminal = terminalId ? terminals.get(terminalId) : undefined
  const terminalDrive = estimate && terminal ? {
    from: String(estimate.details.from_city), terminal: String(terminal.details.name ?? "").replace(" Vehicle Terminal", " terminal"), city: String(terminal.details.city ?? ""),
    km: num(estimate.details.approximate_road_distance_km), minutesLow: num(estimate.details.drive_minutes_low), minutesHigh: num(estimate.details.drive_minutes_high),
    source: ref(`terminal_road_estimates:${estimate.id}@${bundle.order.id}`, "Route planning table"),
  } : null

  return {
    asOf: asOf.toISOString(),
    order: {
      id: bundle.order.id, reference: bundle.order.reference, customerReference: str(bundle.order.details.customer_reference),
      stage: { key: stage, label: stageLabel },
      customer: { id: bundle.customer.id, name: bundle.customer.name, tier: bundle.customer.tier },
      car: car ? {
        make: car.make, model: car.model, year: car.year, registration: car.registration, vin: car.vin, fuel: car.fuel,
        label: `${car.make} ${car.model}`, image: carImage(car.make, car.model),
      } : { make: "", model: "", year: null, registration: null, vin: null, fuel: null, label: "Car not identified yet", image: null },
      tradeIn: tradeIn ? { label: `${tradeIn.vehicle.make} ${tradeIn.vehicle.model}`, registration: tradeIn.vehicle.registration } : null,
      route: {
        from: pickup, to: delivery, via, kind: bundle.order.routeKind === "IMPORT" ? "import" : "domestic",
        distanceKm: segments.filter((segment) => segment.details.order_item_id === primary?.id).reduce((sum, segment) => sum + (num(segment.details.distance_km) ?? 0), 0) || null,
        ferry: segments.some((segment) => segment.details.transport_mode === "DRIVE_WITH_FERRY"),
      },
      driver: driverId ? { id: driverId, name: dir.driverName(driverId) ?? "Driver", home: dir.driverHome(driverId), state: driverState } : null,
      otherDrivers,
      createdAt: bundle.order.createdAt,
      pickedUpAt, deliveredAt, cancelledAt,
    },
    keyTimes,
    facts: factList,
    open: {
      alerts: openAlerts, tasks, incidents,
      cards: openCards.map((card) => ({ id: card.id, headline: card.headline, severity: card.severity, createdAt: iso(card.createdAt), origin: card.origin })),
      proposals, claims, conversations: openThreads, supportInbox, documents,
    },
    plan: {
      stops, legs,
      offer: offer ? {
        state: offer.details.status === "PUBLISHED" ? "offered to drivers, not taken yet" : offer.details.status === "ACCEPTED" ? "taken by a driver" : label(str(offer.details.status)).toLowerCase(),
        fee: money(num(offer.details.fee_cents), str(offer.details.currency)) || null, at: str(offer.details.accepted_at) ?? str(offer.details.published_at),
      } : null,
      bookings, quotes, lastPosition, terminalDrive,
    },
    timeline: [...entries].reverse().slice(0, 40).map(toItem),
  }
}

function severityRank(severity: string): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity] ?? 4
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Case files for many orders (all when no ids are given). The timeline is the last 40 entries. */
export async function getCases(orderIds?: string[]): Promise<CaseFile[]> {
  const asOf = await clockNow()
  const { bundles, shared } = await loadBundles(orderIds ?? null)
  if (!bundles.length) return []
  const ids = bundles.map((bundle) => bundle.order.id)
  const [entryRows, factRows, cardRows, threadMessages, effectRows] = await Promise.all([
    db.select().from(timelineEntries).where(inArray(timelineEntries.orderId, ids)).orderBy(asc(timelineEntries.occurredAt), asc(timelineEntries.id)),
    db.select().from(factsTable).where(inArray(factsTable.orderId, ids)),
    db.select({ id: cards.id, orderId: cards.orderId, headline: cards.headline, severity: cards.severity, createdAt: cards.createdAt, origin: cards.origin })
      .from(cards).where(and(inArray(cards.orderId, ids), eq(cards.status, "open"))),
    db.execute<{ id: string; conversation_id: string }>(sql`select id, conversation_id from messages`),
    db.select({ orderId: cards.orderId, effect: decisions.executedEffect }).from(decisions).innerJoin(cards, eq(cards.id, decisions.cardId))
      .where(and(inArray(cards.orderId, ids), isNull(decisions.undoneAt))),
  ])
  const messageThreads = new Map([...threadMessages].map((row) => [row.id, row.conversation_id]))
  const inboxEntryRows = await db.select().from(timelineEntries).where(and(isNull(timelineEntries.orderId), sql`${timelineEntries.evidence}->>'table' = 'support_inbox_messages'`))
  const inboxMessages = await db.select({ id: relatedRecords.id, details: relatedRecords.details }).from(relatedRecords).where(eq(relatedRecords.collection, "support_inbox_messages"))
  const threadOfInbox = new Map(inboxMessages.map((row) => [row.id, String(row.details.thread_id ?? "")]))
  const terminals = new Map(shared.filter((row) => row.collection === "ferry_terminals").map((row) => [row.id, { id: row.id, details: row.details }]))
  const roadEstimates = shared.filter((row) => row.collection === "terminal_road_estimates").map((row) => ({ id: row.id, details: row.details }))
  const by = <T extends { orderId: string | null }>(list: T[]) => {
    const map = new Map<string, T[]>()
    for (const item of list) if (item.orderId) { const bucket = map.get(item.orderId) ?? []; bucket.push(item); map.set(item.orderId, bucket) }
    return map
  }
  const entriesByOrder = by(entryRows)
  const factsByOrder = by(factRows)
  const cardsByOrder = by(cardRows)
  return bundles.map((bundle) => {
    const threadIds = new Set(bundle.inboxThreads.map((thread) => thread.id))
    return compile({
      bundle, asOf, terminals, roadEstimates, messageThreads,
      effects: effectRows.filter((row) => row.orderId === bundle.order.id && row.effect).map((row) => row.effect as ExecutedEffect),
      entries: entriesByOrder.get(bundle.order.id) ?? [],
      factRows: factsByOrder.get(bundle.order.id) ?? [],
      openCards: cardsByOrder.get(bundle.order.id) ?? [],
      inboxEntries: inboxEntryRows.filter((entry) => threadIds.has(threadOfInbox.get(entry.evidence.id) ?? "")),
    })
  })
}

/** One compiled case file, by order id or reference. */
export async function getCase(idOrReference: string): Promise<CaseFile | null> {
  const id = await resolveOrderId(idOrReference)
  if (!id) return null
  const [file] = await getCases([id])
  return file ?? null
}

/** The order's timeline in time order, optionally only entries after `since`. */
export async function timeline(idOrReference: string, since?: Date | string | null): Promise<TimelineItem[]> {
  const id = await resolveOrderId(idOrReference)
  if (!id) return []
  const sinceDate = since ? new Date(since) : null
  const rowsFound = await db.select().from(timelineEntries)
    .where(sinceDate ? and(eq(timelineEntries.orderId, id), gte(timelineEntries.occurredAt, sinceDate)) : eq(timelineEntries.orderId, id))
    .orderBy(asc(timelineEntries.occurredAt), asc(timelineEntries.id))
  return rowsFound.map(toItem)
}

export type SearchHit = {
  orderId: string
  reference: string
  car: string
  customer: string
  route: string
  /** A matching passage when the match was in a message. */
  snippet: string | null
}

/** Full-text search over reference, plate, VIN, car, customer, driver, cities and message bodies. */
export async function search(query: string, limit = 20): Promise<SearchHit[]> {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  if (!tokens.length) return []
  const tsquery = tokens.map((token) => `${token}:*`).join(" & ")
  const like = `%${query.trim()}%`
  const result = await db.execute<{ order_id: string; reference: string; snippet: string }>(sql`
    select d.order_id, d.reference,
      ts_headline('simple', split_part(d.content, ${SEARCH_SEPARATOR}, 2), q, 'MaxFragments=1, MaxWords=14, MinWords=6, StartSel=«, StopSel=»') as snippet
    from ${searchDocuments} d, to_tsquery('simple', ${tsquery}) q
    where d.tsv @@ q or d.reference ilike ${like} or d.content ilike ${like}
    order by (d.reference ilike ${like}) desc, ts_rank(d.tsv, q) desc, d.reference
    limit ${limit}
  `)
  const hits = [...result]
  if (!hits.length) return []
  const ids = hits.map((hit) => hit.order_id)
  const [orderRows, itemRows, customerRows, addressRows] = await Promise.all([
    db.select().from(orders).where(inArray(orders.id, ids)),
    db.select({ orderId: orderItems.orderId, role: orderItems.role, make: vehicles.make, model: vehicles.model }).from(orderItems)
      .innerJoin(vehicles, eq(orderItems.vehicleId, vehicles.id)).where(inArray(orderItems.orderId, ids)),
    db.select().from(customers),
    db.select().from(addresses),
  ])
  const orderMap = new Map(orderRows.map((order) => [order.id, order]))
  const customerMap = new Map(customerRows.map((row) => [row.id, row.name]))
  const addressMap = new Map(addressRows.map((row) => [row.id, row.city]))
  return hits.map((hit) => {
    const order = orderMap.get(hit.order_id) as OrderRow
    const item = itemRows.find((row) => row.orderId === hit.order_id && row.role === "PRIMARY") ?? itemRows.find((row) => row.orderId === hit.order_id)
    const snippet = hit.snippet.includes("«") ? hit.snippet.replace(/\s+/g, " ").trim() : null
    return {
      orderId: hit.order_id, reference: hit.reference,
      car: item ? `${item.make} ${item.model}` : "Car not identified yet",
      customer: customerMap.get(order.customerId) ?? "",
      route: `${addressMap.get(order.pickupAddressId) ?? "?"} → ${addressMap.get(order.deliveryAddressId) ?? "?"}`,
      snippet,
    }
  })
}

/** Timeline entries by id, for checking what a card cites. */
export async function entriesById(ids: string[]): Promise<Map<string, TimelineItem>> {
  if (!ids.length) return new Map()
  const found = await db.select().from(timelineEntries).where(inArray(timelineEntries.id, [...new Set(ids)]))
  return new Map(found.map((entry) => [entry.id, toItem(entry)]))
}
