// Ops words for dataset codes. Summaries and screens use these instead of raw
// codes. Unknown codes fall back to a readable form of the code itself.

import { humanize, label } from "./present/labels"

const SIGNALS: Record<string, string> = {
  SAFETY_STOP: "Driver stopped: red warning light",
  TRACKING_GAP: "No recent position from the driver app",
  FERRY_SOLD_OUT: "Ferry sold out",
  FERRY_CONNECTION_RISK: "Ferry check-in at risk",
  FERRY_TRACKING_GAP_CONTEXT: "No position during the ferry crossing",
  EMPTY_PICKUP: "Car not found at pickup",
  DRIVER_AVAILABILITY_RISK: "Driver may be ill",
  RELEASE_DOCUMENT_UNCLEAR: "Release paperwork unclear",
  SITE_ACCESS_UNCONFIRMED: "Pickup contact and keys not confirmed",
  SITE_ACCESS_CONFLICT: "Records disagree on where the car is",
  DELIVERY_ACCESS_RISK: "No one confirmed to receive the car",
  PROOF_REVIEW: "Signed handover missing",
  CONDITION_CLAIM_REVIEW: "Damage reported after delivery",
  CONDITION_CLAIM: "Damage reported after delivery",
  INVOICE_REFERENCE_QUERY: "Customer asks about the invoice",
  FR_IMPORT_TRAVEL_DECISION: "Ferry sold out, travel plan needs a decision",
  POSITIONING_AT_RISK: "Driver cannot reach the pickup in time",
  PICKUP_PROOF_REJECTED: "Pickup photos rejected",
  DELIVERY_PROMISE_UNACHIEVABLE: "Delivery promise cannot be met",
}

export function signalLabel(signal: string | null | undefined): string {
  if (!signal) return "Alert"
  return SIGNALS[signal] ?? humanize(signal)
}

const SEVERITY: Record<string, string> = { critical: "critical", high: "high", medium: "medium", low: "low" }
export function severityWord(severity: string | null | undefined): string {
  return severity ? SEVERITY[severity] ?? severity.toLowerCase() : "unknown"
}

const TASKS: Record<string, string> = {
  MARKET_VISIBILITY_CHECK: "Decide whether to pull the driver offer",
  SITE_HANDOVER_REVIEW: "Check the site's release requests",
  DRIVER_START_CHECK: "Check the driver can reach the pickup",
  BACKUP_DRIVER_DECISION: "Decide on a backup driver",
  SIGNED_HANDOVER_FOLLOWUP: "Get the signed handover",
  IDENTITY_INPUT_REQUIRED: "Get the car's VIN or plate",
  PICKUP_CONTACT_HANDLE_REQUIRED: "Get a pickup contact",
  PICKUP_ACCESS_CHECK_REQUIRED: "Get the exact pickup address",
  VEHICLE_RECOVERY_DECISION: "Decide on recovery of the stopped car",
  PICKUP_EVIDENCE_FOLLOWUP: "Replace the rejected pickup photos",
  RECEIVER_AUTHORITY_CHECK: "Find who can receive and sign",
  KEY_HOLDER_STOCK_CHECK: "Find who holds the keys",
  COMMERCIAL_RELEASE_HOLD: "Clear the seller's hold",
}

export function taskLabel(kind: string | null | undefined): string {
  if (!kind) return "Follow-up"
  return TASKS[kind] ?? humanize(kind)
}

const INCIDENTS: Record<string, string> = {
  EMPTY_PICKUP: "car not found at pickup",
  TRAVEL_CAPACITY: "no ferry space",
  VEHICLE_WARNING: "warning light, car stopped",
  POST_DELIVERY_CONDITION_CLAIM: "damage claim after delivery",
}

export function incidentLabel(kind: string | null | undefined): string {
  if (!kind) return "incident"
  return INCIDENTS[kind] ?? humanize(kind).toLowerCase()
}

const DOCUMENTS: Record<string, string> = {
  CMR: "CMR",
  RELEASE_AUTHORITY: "Release authority",
  SIGNED_HANDOVER: "Signed handover",
  CONDITION_PHOTO: "Warning light photo",
}

export function documentLabel(kind: string | null | undefined): string {
  return kind ? DOCUMENTS[kind] ?? label(kind) : "Document"
}

const PROOFS: Record<string, string> = {
  PICKUP_PHOTOS: "Pickup photos",
  DELIVERY_PHOTOS: "Delivery photos",
  KEY_PICKUP_PHOTOS: "Key photos at pickup",
  KEY_DELIVERY_PHOTOS: "Key photos at delivery",
  TRADE_IN_PICKUP_PHOTOS: "Trade-in pickup photos",
  TRADE_IN_DELIVERY_PHOTOS: "Trade-in delivery photos",
  YARD_ARRIVAL_PHOTOS: "Yard arrival photos",
  YARD_RELEASE_PHOTOS: "Yard release photos",
}

export function proofLabel(kind: string | null | undefined): string {
  return kind ? PROOFS[kind] ?? label(kind) : "Photos"
}

const EXPENSES: Record<string, string> = {
  FUEL: "Fuel", CHARGING: "Charging", PARKING: "Parking", TOLL: "Toll", HOTEL: "Hotel",
  TRAIN_POSITIONING: "Train to the pickup", BUS_POSITIONING: "Bus to the pickup",
  FLIGHT_POSITIONING: "Flight to the pickup", TAXI_POSITIONING: "Taxi to the pickup",
}

export function expenseLabel(kind: string | null | undefined): string {
  return kind ? EXPENSES[kind] ?? label(kind) : "Cost"
}

const TRAVEL: Record<string, string> = { FERRY: "Ferry", TRAIN: "Train", FLIGHT: "Flight", HOTEL: "Hotel", BUS: "Bus", TAXI: "Taxi" }
export function travelLabel(kind: string | null | undefined): string {
  return kind ? TRAVEL[kind] ?? label(kind) : "Travel"
}

const BOUNDARY: Record<string, string> = { PICKUP: "Pickup", DELIVERY: "Delivery", TRANSFER: "Transfer yard" }
export function boundaryLabel(boundary: string | null | undefined): string {
  return boundary ? BOUNDARY[boundary] ?? label(boundary) : "Stop"
}

const CLAIM_SOURCES: Record<string, string> = {
  CUSTOMER_ORDER_INPUT: "Customer, order form",
  HANDOFF_CONTACT: "Handover contact",
  HANDOFF_CONTACT_MESSAGE: "Handover contact, message",
  MANAGED_SITE_PROFILE: "Site profile",
  SITE_CONTACT_REPLY: "Site contact reply",
  SITE_ACCESS_REPLY: "Site reply",
  HANDOFF_ACCESS_REPLY: "Handover contact reply",
  DIRECT_HANDOFF_CONTACT_REPLY: "Handover contact reply",
  CUSTOMER_AND_HANDOFF_CONTACT: "Customer and handover contact",
}

export function claimSourceLabel(code: string | null | undefined): string {
  return code ? CLAIM_SOURCES[code] ?? label(code) : "Source not recorded"
}

const WINDOW_SOURCES: Record<string, string> = { CUSTOMER: "Customer", OPS: "Ops", SYSTEM: "System estimate", SITE: "Site" }
export function windowSourceLabel(code: string | null | undefined): string {
  return code ? WINDOW_SOURCES[code] ?? label(code) : "Source not recorded"
}

export function money(cents: number | null | undefined, currency: string | null | undefined): string {
  if (typeof cents !== "number" || !currency) return ""
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

/** First sentence (or the first ~150 characters) of a message, for a one-line summary. */
export function oneLine(text: string, max = 150): string {
  const clean = text.replace(/\s+/g, " ").trim()
  const sentence = clean.match(/^.+?[.!?](\s|$)/)?.[0]?.trim() ?? clean
  const pick = sentence.length >= 25 || sentence === clean ? sentence : clean
  if (pick.length <= max) return pick
  const cut = pick.slice(0, max)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40))}…`
}
