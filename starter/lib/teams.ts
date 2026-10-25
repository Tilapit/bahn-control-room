// Team views: which market and which desk a card belongs to, decided by code from the records, never by a model.
// Market = the customer's country. Desk = one of Bahn's desks (dataset operators.jsonl), from the card's action type.
// Pure functions only: the client's view switcher imports this file too.

import type { StageKey } from "./case"

export const MARKETS = ["Finland", "Denmark", "Germany", "Other"] as const
export type Market = (typeof MARKETS)[number]

export const DESKS = ["Readiness", "Dispatch", "Crossings & travel", "On the road", "Handover", "Support"] as const
export type Desk = (typeof DESKS)[number]

/** Market and route of one order, and the desk of its open card (null when nothing is open on it). */
export type Team = { market: Market; countries: string[]; crossBorder: boolean; desk: Desk | null }

/** What one person looks at: a market (or everyone), some desks (none ticked = all desks), and orders passing through. */
export type TeamView = { market: "Everyone" | Market; desks: Desk[]; passingThrough: boolean }
export const DEFAULT_VIEW: TeamView = { market: "Everyone", desks: [], passingThrough: false }

const MARKET_OF_COUNTRY: Record<string, Market> = { FI: "Finland", DK: "Denmark", DE: "Germany" }
const COUNTRY_OF_MARKET: Record<Exclude<Market, "Other">, string> = { Finland: "FI", Denmark: "DK", Germany: "DE" }
const COUNTRY_NAMES: Record<string, string> = {
  FI: "Finland", DK: "Denmark", DE: "Germany", SE: "Sweden", FR: "France", NL: "the Netherlands", BE: "Belgium", AT: "Austria",
}

/** "FI" → Finland; every country Bahn has no team for (France, the Netherlands…) is Other. */
export function marketOf(country: string | null | undefined): Market {
  return (country && MARKET_OF_COUNTRY[country.toUpperCase()]) || "Other"
}

/** "SE" → "Sweden", for the "Cross-border" hover line. */
export function countryName(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] ?? code
}

/** An order's market and route from the customer's country and every country its route touches (pickup, stops, ferry, delivery). */
export function routeTeam(customerCountry: string | null | undefined, routeCountries: (string | null | undefined)[]): Omit<Team, "desk"> {
  const market = marketOf(customerCountry)
  const countries = [...new Set(routeCountries.filter((code): code is string => !!code).map((code) => code.toUpperCase()))]
  // Cross-border: the route leaves the customer's own country. For "Other", any route through Finland, Denmark or Germany.
  const home = customerCountry?.toUpperCase() ?? null
  const crossBorder = countries.some((code) => code !== home)
  return { market, countries, crossBorder }
}

// ---------------------------------------------------------------------------
// Desks
// ---------------------------------------------------------------------------

/**
 * The desk that owns each kind of action a card can propose. Actions not listed here (messages, calls, notes,
 * answers) say who is told, not what the work is: for them the order's open alert, then its stage, decides.
 */
const DESK_OF_ACTION: Record<string, Desk> = {
  // On the road (ops-shift, "Shift lead"): a car on its way that broke down or will be late.
  book_tow: "On the road", approve_repair_cost: "On the road", change_delivery_time: "On the road",
  // Readiness (ops-readiness): is the car ready to collect: the pickup time, release, keys, contacts.
  change_pickup_time: "Readiness",
  // Dispatch (ops-dispatch, "Driver marketplace"): who drives: an offer again, a higher fee, another driver.
  switch_driver: "Dispatch", republish_offer: "Dispatch", raise_fee: "Dispatch",
  // Crossings & travel (ops-travel, "Driver travel", and ferry work): ferries, the driver's trains, flights and hotels.
  book_ferry: "Crossings & travel", change_ferry_booking: "Crossings & travel",
  cancel_driver_travel: "Crossings & travel", book_driver_travel: "Crossings & travel", book_hotel: "Crossings & travel",
}

/** When the card's own action says nothing, the first of these among its steps decides, in this order. */
const STEP_PRIORITY = ["book_tow", "approve_repair_cost", "change_pickup_time", "switch_driver", "republish_offer", "raise_fee",
  "book_ferry", "change_ferry_booking", "cancel_driver_travel", "book_driver_travel", "book_hotel", "change_delivery_time"]

/**
 * Bahn's own desks, as the records name them (operators.jsonl): the owner of an open work item or alert, by id or title.
 * Planning, intake, import, finance and expenses have no view of their own; they go to the desk that does that work here.
 */
const DESK_OF_OWNER: Record<string, Desk> = {
  "ops-readiness": "Readiness", "Readiness desk": "Readiness", "ops-intake": "Readiness", "Order intake": "Readiness",
  "ops-dispatch": "Dispatch", "Driver marketplace": "Dispatch",
  "ops-travel": "Crossings & travel", "Driver travel": "Crossings & travel", "ops-planning": "Crossings & travel", "Transport planning": "Crossings & travel",
  "ops-import": "Crossings & travel", "Import operations": "Crossings & travel",
  "ops-shift": "On the road", "Shift lead": "On the road",
  "ops-evidence": "Handover", "Handover evidence": "Handover",
  "ops-support": "Support", "Support desk": "Support", "ops-finance": "Support", "Cancellation and payment review": "Support",
  "ops-expenses": "Dispatch", "Driver expense review": "Dispatch",
}

/** An open alert's signal → the desk that answers it (dataset alerts.signal), when no record names an owner. */
const DESK_OF_SIGNAL: [RegExp, Desk][] = [
  // Support (ops-support, "Support desk"): what a customer asks that is not about the car's trip.
  [/^INVOICE|PAYMENT|REFUND/, "Support"],
  // Handover (ops-evidence, "Handover evidence"): proof, condition claims, who receives the car.
  [/PROOF|CONDITION_CLAIM|DELIVERY_ACCESS|HANDOVER|DAMAGE/, "Handover"],
  [/^FERRY|TRAVEL|POSITIONING|TRAIN|FLIGHT/, "Crossings & travel"],
  [/DRIVER_AVAILABILITY|OFFER|NO_DRIVER|GIG/, "Dispatch"],
  [/SAFETY|TRACKING|ETA|DELIVERY_PROMISE|BREAKDOWN|DEVIATION/, "On the road"],
  [/PICKUP|RELEASE|SITE_ACCESS|KEYS|READINESS/, "Readiness"],
]

/** With nothing more specific, the stage of the order decides: who owns an order at that point of its trip. */
const DESK_OF_STAGE: Record<StageKey, Desk> = {
  intake: "Readiness", ready: "Readiness", driver_booked: "Readiness",
  finding_driver: "Dispatch",
  moving: "On the road", at_transfer: "On the road",
  delivered: "Handover",
  cancelled: "Support",
}

export type DeskInput = {
  severity: string | null
  /** The card's own action type (`proposal.action`). */
  action: string | null
  /** Every step action of the option the card leads with. */
  steps: string[]
  /** Who owns the order's open work items, then its open alerts, in the records: desk ids ("ops-travel") or titles. */
  owners: string[]
  /** The order's open alerts' signals, most urgent first. */
  signals: string[]
  stage: StageKey | null
}

/**
 * Exactly one desk for a card. A person's safety is always On the road: the shift lead answers it first. Then the
 * card's action type, then the most telling step of the option it leads with. A card that only messages, calls or
 * notes goes to the desk the records already gave the order's open work, then to the desk its alert belongs to.
 */
export function deskOf(input: DeskInput): Desk {
  if (input.severity === "safety") return "On the road"
  if (input.action && DESK_OF_ACTION[input.action]) return DESK_OF_ACTION[input.action]
  const step = STEP_PRIORITY.find((action) => input.steps.includes(action))
  if (step) return DESK_OF_ACTION[step]
  const owner = input.owners.find((name) => DESK_OF_OWNER[name])
  if (owner) return DESK_OF_OWNER[owner]
  for (const signal of input.signals) {
    const hit = DESK_OF_SIGNAL.find(([pattern]) => pattern.test(signal))
    if (hit) return hit[1]
  }
  // Talking to the customer is the work itself when nothing above names another desk.
  if (input.action === "message_customer" || input.action === "call_customer") return "Support"
  return input.stage ? DESK_OF_STAGE[input.stage] : "Support"
}

/** The option a card leads with and its step actions, from a card's stored options. */
export function cardActions(card: { proposal: { action?: string | null } | null; options: { kind?: string; steps?: { action: string }[] }[] }): { action: string | null; steps: string[] } {
  const primary = card.options.find((option) => option.kind !== "reject" && option.kind !== "answer") ?? card.options.find((option) => option.kind !== "reject") ?? null
  return { action: card.proposal?.action ?? null, steps: (primary?.steps ?? []).map((step) => step.action) }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * Is this order in the view? Its market must match, or, with "passing through" on, its route must touch the
 * view's country. Ticked desks keep only orders with an open card at one of them.
 */
export function inView(team: Team, view: TeamView): boolean {
  if (view.desks.length && (!team.desk || !view.desks.includes(team.desk))) return false
  if (view.market === "Everyone" || team.market === view.market) return true
  if (!view.passingThrough || !team.crossBorder || view.market === "Other") return false
  return team.countries.includes(COUNTRY_OF_MARKET[view.market])
}

/** In the view only because its route passes through the view's country: the row says "Cross-border". */
export function passesThrough(team: Team, view: TeamView): boolean {
  return view.market !== "Everyone" && team.market !== view.market && inView(team, view)
}

/** "Finland · All desks", "Everyone · Dispatch", "Germany · 2 desks". */
export function viewLabel(view: TeamView): string {
  const desks = view.desks.length === 0 || view.desks.length === DESKS.length ? "All desks" : view.desks.length === 1 ? view.desks[0] : `${view.desks.length} desks`
  return `${view.market} · ${desks}`
}

/** "in Finland", "at Dispatch in Finland", "" for everyone at every desk: the end of a header line. */
export function viewWords(view: TeamView): string {
  const desks = view.desks.length === 0 || view.desks.length === DESKS.length ? "" : view.desks.length === 1 ? `at ${view.desks[0]}` : `at ${view.desks.length} desks`
  const market = view.market === "Everyone" ? "" : view.market === "Other" ? "in other countries" : `in ${view.market}`
  return [desks, market].filter(Boolean).join(" ")
}

/** A stored view, checked field by field: anything unknown falls back to the default. */
export function parseView(value: unknown): TeamView {
  if (!value || typeof value !== "object") return DEFAULT_VIEW
  const raw = value as Record<string, unknown>
  const market = raw.market === "Everyone" || MARKETS.includes(raw.market as Market) ? raw.market as TeamView["market"] : "Everyone"
  const desks = Array.isArray(raw.desks) ? DESKS.filter((desk) => (raw.desks as unknown[]).includes(desk)) : []
  return { market, desks, passingThrough: raw.passingThrough === true }
}
