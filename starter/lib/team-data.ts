// Team views, the records behind them: each order's market (customers.country) and the countries its route touches,
// read in three queries for any number of orders. The rules themselves are in lib/teams.ts.

import { and, eq, inArray, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import type { CaseFile } from "./case"
import { db } from "./db"
import { addresses, customers, orders, relatedRecords } from "./schema"
import { cardActions, deskOf, routeTeam, type Desk, type Team } from "./teams"

export type OrderRoute = Omit<Team, "desk">

const pickup = alias(addresses, "pickup")
const delivery = alias(addresses, "delivery")

/** "West Baltic terminal" and "West Baltic Vehicle Terminal" name the same place. */
const terminalKey = (name: string) => name.toLowerCase().replace(/\s+(vehicle\s+)?terminal$/, "").trim()

/**
 * Market and route countries per order: the pickup and delivery addresses, every stop of the active plan
 * (a transfer yard can sit in a third country) and the terminals of a booked ferry. A quote is not part of the route.
 * The driver's own trains and flights are not either: they move the driver, not the car.
 */
export async function orderRoutes(ids?: string[]): Promise<Map<string, OrderRoute>> {
  if (ids && !ids.length) return new Map()
  const scope = ids ? inArray(orders.id, ids) : undefined
  const [base, points, ferries, terminals, places] = await Promise.all([
    db.select({ id: orders.id, market: customers.country, from: pickup.country, to: delivery.country, plan: sql<string | null>`${orders.details}->>'active_plan_id'` })
      .from(orders).innerJoin(customers, eq(customers.id, orders.customerId))
      .innerJoin(pickup, eq(pickup.id, orders.pickupAddressId)).innerJoin(delivery, eq(delivery.id, orders.deliveryAddressId)).where(scope),
    db.select({ orderId: relatedRecords.orderId, details: relatedRecords.details }).from(relatedRecords)
      .where(and(eq(relatedRecords.collection, "transport_points"), ids ? inArray(relatedRecords.orderId, ids) : undefined)),
    db.select({ orderId: relatedRecords.orderId, details: relatedRecords.details }).from(relatedRecords)
      .where(and(eq(relatedRecords.collection, "travel_reservations"), sql`${relatedRecords.details}->>'kind' = 'FERRY'`, sql`${relatedRecords.details}->>'status' = 'BOOKED'`, ids ? inArray(relatedRecords.orderId, ids) : undefined)),
    db.select({ details: relatedRecords.details }).from(relatedRecords).where(eq(relatedRecords.collection, "ferry_terminals")),
    db.select({ id: addresses.id, country: addresses.country }).from(addresses),
  ])
  const countryOf = new Map(places.map((row) => [row.id, row.country]))
  const terminalCountry = new Map(terminals.map((row) => [terminalKey(String(row.details.name ?? "")), String(row.details.country ?? "")]))
  const extra = new Map<string, string[]>()
  const add = (orderId: string | null, country: string | null | undefined) => {
    if (!orderId || !country) return
    const list = extra.get(orderId)
    if (list) list.push(country); else extra.set(orderId, [country])
  }
  const plans = new Map(base.map((row) => [row.id, row.plan]))
  for (const point of points) {
    // Only the plan the order follows now: an earlier plan's transfer yard is not on the route any more.
    const plan = point.orderId ? plans.get(point.orderId) : null
    if (plan && point.details.plan_id !== plan) continue
    add(point.orderId, countryOf.get(String(point.details.address_id ?? "")))
  }
  for (const ferry of ferries) {
    add(ferry.orderId, terminalCountry.get(terminalKey(String(ferry.details.from_city ?? ""))))
    add(ferry.orderId, terminalCountry.get(terminalKey(String(ferry.details.to_city ?? ""))))
  }
  return new Map(base.map((row) => [row.id, routeTeam(row.market, [row.from, ...(extra.get(row.id) ?? []), row.to])]))
}

type CardLike = { severity: string; proposal: { action?: string | null } | null; options: { kind?: string; steps?: { action: string }[] }[] }

/** The desk of a card on this order: its action type first, then the order's open alerts, then its stage. */
export function cardDesk(card: CardLike, file: Pick<CaseFile, "order" | "open"> | null): Desk {
  const { action, steps } = cardActions(card)
  const owners = [...(file?.open.tasks ?? []), ...(file?.open.alerts ?? [])].map((item) => item.owner).filter((owner): owner is string => !!owner)
  return deskOf({ severity: card.severity, action, steps, owners, signals: file?.open.alerts.map((alert) => alert.signal) ?? [], stage: file?.order.stage.key ?? null })
}

/** An order's team: its route, and the desk of its open card, if it has one. */
export function teamOf(route: OrderRoute | undefined, card: CardLike | null, file: Pick<CaseFile, "order" | "open"> | null): Team {
  return { ...(route ?? routeTeam(null, [])), desk: card ? cardDesk(card, file) : null }
}
