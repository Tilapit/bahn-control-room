// The outside world, mocked (the brief allows it): the ferry line, hotels, trains
// and flights, repair shops and the driver pool. Deterministic: the same question
// gets the same answer, so runs can be compared. Where the dataset has data (a
// quote, a sold-out check, a reservation, the drivers table) the mock answers
// from it; elsewhere it fills in a fictional timetable or price from a hash.

import { and, eq, inArray } from "drizzle-orm"
import { db } from "../db"
import { activeDisruptions } from "../disruptions"
import { cityAt } from "../geo"
import { addresses, type DisruptionScope, drivers, orders, relatedRecords } from "../schema"
import { at, clock } from "../time"
import { money } from "../words"

type Row = Record<string, unknown>

const HOUR = 3600_000

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

const pick = <T,>(seed: string, list: T[]): T => list[hash(seed) % list.length]
const between = (seed: string, low: number, high: number) => low + (hash(seed) % (high - low + 1))
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")

async function orderRecords(orderId: string, collections: string[]): Promise<{ collection: string; id: string; details: Row }[]> {
  return db.select({ collection: relatedRecords.collection, id: relatedRecords.id, details: relatedRecords.details }).from(relatedRecords)
    .where(and(eq(relatedRecords.orderId, orderId), inArray(relatedRecords.collection, collections)))
}

const TERMINAL_ZONE: Record<string, string> = {
  "West Baltic": "Europe/Berlin", "South Finland": "Europe/Helsinki", "East Sweden": "Europe/Stockholm",
  "East Nordic": "Europe/Stockholm", "South Baltic": "Europe/Copenhagen",
}
const zoneOfTerminal = (name: string) => TERMINAL_ZONE[Object.keys(TERMINAL_ZONE).find((key) => name.startsWith(key)) ?? ""] ?? "UTC"
/** The city each terminal is in (dataset ferry_terminals), so a sailing says where it lands. */
const TERMINAL_CITY: Record<string, string> = { "West Baltic": "Hamburg", "South Finland": "Helsinki", "East Nordic": "Stockholm", "East Sweden": "Stockholm", "South Baltic": "Copenhagen" }
const cityOfTerminal = (name: string) => TERMINAL_CITY[Object.keys(TERMINAL_CITY).find((key) => name.startsWith(key)) ?? ""] ?? null
const terminalName = (name: string) => name.replace(/ (Vehicle )?[Tt]erminal$/, "")

// ---------------------------------------------------------------------------
// Ferries
// ---------------------------------------------------------------------------

export type FerryOption = {
  id: string
  provider: string
  from: string
  to: string
  departureAt: string
  checkInCutoffAt: string
  arrivalAt: string
  priceCents: number | null
  state: "quote" | "sold out" | "booked for this car"
  checkedAt: string
  /** The dataset quote this re-check repeats, when there is one. */
  datasetOptionId: string | null
}

export function describeFerry(option: FerryOption): string {
  const fromZone = zoneOfTerminal(option.from)
  const price = option.priceCents != null ? `, ${money(option.priceCents, "EUR")}` : ""
  const state = option.state === "quote" ? "quote, not booked" : option.state
  const fromCity = cityOfTerminal(option.from)
  const toCity = cityOfTerminal(option.to)
  return `${option.provider}, ${terminalName(option.from)}${fromCity ? ` (${fromCity})` : ""} to ${terminalName(option.to)}${toCity ? ` (${toCity})` : ""}, departs ${at(option.departureAt, fromZone)}, check-in closes ${clock(option.checkInCutoffAt, fromZone)}, arrives ${at(option.arrivalAt, zoneOfTerminal(option.to))}${toCity ? ` in ${toCity}` : ""}${price} (${state})`
}

/** Ferry crossings on the order's route after a time. Dataset quotes and sold-out checks repeat as they were; other sailings follow the line's timetable. */
export async function ferryOptions(orderId: string, after: Date, now: Date): Promise<{ route: string; options: FerryOption[] }> {
  const records = await orderRecords(orderId, ["travel_options", "travel_reservations"])
  const quotes = records.filter((row) => row.collection === "travel_options" && row.details.kind === "FERRY")
  const reservation = records.find((row) => row.collection === "travel_reservations" && row.details.kind === "FERRY" && row.details.status === "BOOKED")
  const from = String(quotes[0]?.details.from_city ?? reservation?.details.origin_terminal ?? "West Baltic terminal")
  const to = String(quotes[0]?.details.to_city ?? reservation?.details.destination_terminal ?? "South Finland terminal")
  // The booked crossing on some orders names no operator; it is "the ferry line" then.
  const provider = String(quotes[0]?.details.provider ?? (reservation ? "The booked ferry line" : "Vela Coast Lines"))
  const options = new Map<string, FerryOption>()

  // The line's timetable: two sailings a day, ten hours apart (the booked sailing's hour, or 12:00 and 22:00 UTC),
  // 28 hours at sea, check-in closes 2 hours before. Sailings whose check-in has closed are left out.
  const bookedHour = reservation ? new Date(String(reservation.details.departure_at)).getUTCHours() : 12
  const hours = [bookedHour, (bookedHour + 10) % 24].sort((a, b) => a - b)
  const open = (departure: Date) => departure.getTime() - 2 * HOUR > now.getTime() && departure >= after
  const day = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate())
  for (let d = 0; d < 4; d += 1) {
    for (const hour of hours) {
      const departure = new Date(day + d * 24 * HOUR + hour * HOUR)
      if (!open(departure)) continue
      const key = departure.toISOString()
      const seed = `${from}|${to}|${key}`
      options.set(key, {
        id: `ferry:${slug(provider)}:${key}`, provider, from, to, departureAt: key,
        checkInCutoffAt: new Date(departure.getTime() - 2 * HOUR).toISOString(),
        arrivalAt: new Date(departure.getTime() + 28 * HOUR).toISOString(),
        priceCents: between(seed, 26, 52) * 1000 + 900,
        state: hash(seed) % 5 === 0 ? "sold out" : "quote",
        checkedAt: now.toISOString(), datasetOptionId: null,
      })
    }
  }
  // Dataset rows win over the timetable for the same sailing: a quote stays at its price, a sold-out check stays sold out.
  for (const row of quotes) {
    const d = row.details
    // Same key format as the timetable ("…T22:00:00.000Z"), so a dataset row replaces its sailing instead of repeating it.
    const departure = new Date(String(d.departure_at)).toISOString()
    if (!open(new Date(departure))) continue
    options.set(departure, {
      id: `ferry:${slug(String(d.provider))}:${departure}`, provider: String(d.provider), from: String(d.from_city), to: String(d.to_city), departureAt: departure,
      checkInCutoffAt: String(d.check_in_cutoff_at), arrivalAt: String(d.arrival_at),
      priceCents: typeof d.quote_cents === "number" ? d.quote_cents : null,
      state: d.status === "SOLD_OUT" ? "sold out" : "quote",
      checkedAt: now.toISOString(), datasetOptionId: row.id,
    })
  }
  if (reservation && open(new Date(String(reservation.details.departure_at)))) {
    const d = reservation.details
    const departure = new Date(String(d.departure_at)).toISOString()
    options.set(departure, {
      id: `ferry:booked:${reservation.id}`, provider, from, to, departureAt: departure,
      checkInCutoffAt: String(d.check_in_cutoff_at), arrivalAt: String(d.expected_arrival_at), priceCents: null,
      state: "booked for this car", checkedAt: now.toISOString(), datasetOptionId: null,
    })
  }
  const list = [...options.values()].sort((a, b) => a.departureAt.localeCompare(b.departureAt)).slice(0, 6)
  return { route: `${terminalName(from)} to ${terminalName(to)}`, options: list }
}

/** What the ferry line has on file for this car: confirmed bookings, and what happened to a request that timed out. */
export async function ferryBookingStatus(orderId: string): Promise<{ text: string; summary: string; hasBooking: boolean }> {
  const records = await orderRecords(orderId, ["travel_reservations", "agent_proposals"])
  const bookings = records.filter((row) => row.collection === "travel_reservations" && row.details.kind === "FERRY" && row.details.status === "BOOKED")
  const failed = records.filter((row) => row.collection === "agent_proposals" && row.details.command === "travel.book_ferry" && row.details.status === "FAILED")
  const lines: string[] = []
  for (const row of bookings) {
    const d = row.details
    const zone = zoneOfTerminal(String(d.origin_terminal ?? ""))
    const amendment = d.amendment_request as Row | undefined
    lines.push(`Booking ${d.booking_reference} is active: vehicle space on the ${at(d.departure_at, zone)} sailing from ${terminalName(String(d.origin_terminal))}, check-in closes ${clock(d.check_in_cutoff_at, zone)}.${amendment ? ` A request to move it to a later crossing was received ${at(amendment.requested_at, zone)} and is not confirmed: no later sailing or fare is held.` : ""}`)
  }
  for (const row of failed) {
    const attempted = String((row.details.execution as Row | undefined)?.attempted_at ?? row.details.created_at)
    lines.push(`The booking request sent ${at(attempted, "Europe/Berlin")} did not reach the reservation system before it timed out. No booking was created from it, no vehicle space is held and nothing was charged. It is safe to send a new booking request.`)
  }
  if (!bookings.length) lines.push("There is no booking for this car on any sailing.")
  const summary = bookings.length
    ? `Ferry line confirms booking ${String(bookings[0].details.booking_reference)} is active`
    : `Ferry line has no booking for this car${failed.length ? "; the timed-out request created none and nothing was charged" : ""}`
  return { text: lines.join("\n"), summary, hasBooking: bookings.length > 0 }
}

// ---------------------------------------------------------------------------
// Hotels, trains and flights for the driver
// ---------------------------------------------------------------------------

export type HotelOption = { id: string; name: string; city: string; checkIn: string; checkOut: string; priceCents: number; note: string }

const HOTEL_NAMES = ["Lantern Quay Rooms", "Norderkai Lodge", "Harbour Gate Inn", "Pier Nine Hotel", "Saltmarsh Rooms", "Old Crane Hotel"]

export function hotelOptions(city: string, checkIn: string, checkOut: string): HotelOption[] {
  const nights = Math.max(1, Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / (24 * HOUR)))
  const names = [...HOTEL_NAMES].sort((a, b) => hash(`${city}|${a}`) - hash(`${city}|${b}`)).slice(0, 3)
  return names.map((name, index) => {
    const seed = `${city}|${name}|${checkIn}`
    return {
      id: `hotel:${slug(name)}:${slug(city)}:${checkIn.slice(0, 10)}`,
      name: `${name} ${city}`, city, checkIn, checkOut,
      priceCents: (between(seed, 79, 139) + index * 6) * 100 * nights,
      note: index === 0 ? `${between(seed, 2, 6)} km from the ferry terminal, secure parking for the car` : index === 1 ? "city centre, street parking only" : `${between(seed, 8, 15)} km out, free parking`,
    }
  })
}

// Approximate road distances between cities in the dataset, in km. Fictional planning numbers, both directions.
const ROAD_KM: Record<string, number> = {
  "helsinki|vantaa": 20, "helsinki|espoo": 20, "espoo|vantaa": 25, "helsinki|lahti": 105, "helsinki|turku": 165, "helsinki|tampere": 180,
  "helsinki|jyväskylä": 270, "helsinki|pori": 240, "helsinki|oulu": 610, "helsinki|seinäjoki": 360, "tampere|turku": 160, "lahti|vantaa": 90,
  "aalborg|copenhagen": 410, "aarhus|copenhagen": 300, "copenhagen|odense": 165, "copenhagen|malmö": 45, "hamburg|odense": 300, "copenhagen|hamburg": 300,
  "hamburg|leipzig": 400, "hamburg|munich": 780, "hamburg|berlin": 290, "hamburg|hannover": 150, "berlin|leipzig": 190, "cologne|düsseldorf": 45,
  "frankfurt|cologne": 190, "munich|stuttgart": 230, "stockholm|uppsala": 70, "gothenburg|stockholm": 470, "malmö|gothenburg": 270,
}
function roadKm(from: string, to: string): number {
  const a = from.trim().toLowerCase()
  const b = to.trim().toLowerCase()
  if (a === b) return 10
  return ROAD_KM[`${a}|${b}`] ?? ROAD_KM[`${b}|${a}`] ?? 300
}

export type TravelOption = { id: string; kind: "train" | "flight" | "bus" | "taxi"; provider: string; from: string; to: string; departureAt: string; arrivalAt: string; priceCents: number; datasetOptionId: string | null; note?: string }

/** Trains and flights between two cities after a time. Dataset quotes first. */
export async function travelOptions(from: string, to: string, after: Date): Promise<TravelOption[]> {
  const rowsFound = await db.select({ id: relatedRecords.id, details: relatedRecords.details }).from(relatedRecords).where(eq(relatedRecords.collection, "travel_options"))
  const options: TravelOption[] = rowsFound
    .filter((row) => row.details.kind !== "FERRY" && String(row.details.from_city).toLowerCase() === from.toLowerCase() && String(row.details.to_city).toLowerCase() === to.toLowerCase())
    .filter((row) => new Date(String(row.details.departure_at)) >= after)
    .map((row) => ({
      id: `travel:${row.id}`, kind: String(row.details.kind).toLowerCase() as TravelOption["kind"], provider: String(row.details.provider),
      from: String(row.details.from_city), to: String(row.details.to_city), departureAt: String(row.details.departure_at),
      arrivalAt: String(row.details.expected_arrival_at ?? row.details.arrival_at ?? row.details.departure_at), priceCents: Number(row.details.quote_cents ?? 0), datasetOptionId: row.id,
    }))
  // A fictional timetable fills the gaps, sized by road distance: a local train every 20 minutes and a taxi for
  // short hops, an hourly train for longer ones. An unknown pair is treated as 300 km. During a rail strike in the
  // feed, trains in that country are shown with the notice, and a long-distance coach is offered instead.
  const km = roadKm(from, to)
  const strikes = (await activeDisruptions(after)).filter((notice) => notice.kind === "strike" && (notice.affects as DisruptionScope).modes.includes("train"))
  const struck = (departure: Date) => strikes.find((notice) => departure >= notice.startsAt && departure <= notice.endsAt
    && [cityAt(from), cityAt(to)].some((city) => city && (notice.affects as DisruptionScope).countries?.includes(city.country)))
  const local = km <= 60
  const rideMinutes = local ? Math.max(20, Math.round(km * 1.2)) : Math.round((km / 95) * 60) + 20
  const everyMinutes = local ? 20 : 60
  const first = Math.ceil((after.getTime() + 10 * 60_000) / (everyMinutes * 60_000)) * everyMinutes * 60_000
  if (local) {
    const departure = new Date(after.getTime() + 15 * 60_000)
    options.push({
      id: `travel:taxi:${slug(from)}-${slug(to)}:${departure.toISOString()}`, kind: "taxi", provider: "Local taxi",
      from, to, departureAt: departure.toISOString(), arrivalAt: new Date(departure.getTime() + Math.round(km * 1.5 + 10) * 60_000).toISOString(),
      priceCents: Math.round(15 + km * 1.6) * 100, datasetOptionId: null,
    })
  }
  for (let slot = 0; options.length < 4 && slot < 24; slot += 1) {
    const departure = new Date(first + slot * everyMinutes * 60_000)
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(departure))
    if (hour < 4 || hour > 20) continue
    const seed = `${from}|${to}|${departure.toISOString()}`
    const strike = struck(departure)
    options.push({
      id: `travel:train:${slug(from)}-${slug(to)}:${departure.toISOString()}`, kind: "train", provider: local ? "City rail" : pick(seed, ["Northrail", "Baltic Link Rail"]),
      from, to, departureAt: departure.toISOString(), arrivalAt: new Date(departure.getTime() + rideMinutes * 60_000).toISOString(),
      priceCents: local ? 450 : Math.round(km * 0.18 + between(seed, 5, 25)) * 100, datasetOptionId: null,
      note: strike ? `may not run: ${strike.title.toLowerCase()} (${strike.sourceLabel})` : undefined,
    })
  }
  if (!local && strikes.length) {
    for (const option of options.filter((item) => item.note && item.kind === "train").slice(0, 1)) {
      const departure = new Date(new Date(option.departureAt).getTime() + 30 * 60_000)
      options.push({
        id: `travel:bus:${slug(from)}-${slug(to)}:${departure.toISOString()}`, kind: "bus", provider: "Fernlinie coach",
        from, to, departureAt: departure.toISOString(), arrivalAt: new Date(departure.getTime() + Math.round((km / 70) * 60 + 15) * 60_000).toISOString(),
        priceCents: Math.round(km * 0.12 + 9) * 100, datasetOptionId: null, note: "long-distance coach, not affected by the rail strike",
      })
    }
  }
  return options.sort((a, b) => a.departureAt.localeCompare(b.departureAt)).slice(0, 6)
}

// ---------------------------------------------------------------------------
// Repair shops and recovery
// ---------------------------------------------------------------------------

export type RepairShop = { id: string; name: string; kind: string; distanceKm: number; towEtaMinutes: number; towToShopCents: number; towToDeliveryCents: number | null; note: string }

const SHOP_NAMES = [
  ["Kellerbrook Recovery", "tow and roadside assistance"],
  ["Auenwald Motor Works", "workshop with tow truck"],
  ["Linden Premium Service", "workshop for high-end cars, no tow truck"],
  ["Hartwick Autohilfe", "tow and roadside assistance"],
]

/** Recovery and workshops near a place the driver described. The place is the driver's words, not a verified position. */
export function findRepairShops(near: string, towToDeliveryKm: number | null): RepairShop[] {
  return SHOP_NAMES.slice(0, 3).map(([name, kind], index) => {
    const seed = `${near}|${name}`
    return {
      id: `shop:${slug(name)}`, name: String(name), kind: String(kind),
      distanceKm: between(seed, 6, 28), towEtaMinutes: kind.includes("no tow") ? 0 : between(seed, 40, 95),
      towToShopCents: kind.includes("no tow") ? 0 : between(seed, 180, 320) * 100,
      towToDeliveryCents: kind.includes("no tow") || towToDeliveryKm == null ? null : Math.round((250 + towToDeliveryKm * 2.4) / 10) * 1000,
      note: index === 2 ? "Can read the warning code and give a diagnosis today if the car is brought in" : index === 0 ? "24-hour line; flatbed suitable for low cars" : "Open until 18:00",
    }
  })
}

// ---------------------------------------------------------------------------
// Backup drivers
// ---------------------------------------------------------------------------

export type DriverOption = { id: string; name: string; home: string; note: string }

/** Active drivers who live in the pickup city and have no other live gig in the records. Availability still needs their yes. */
export async function findBackupDrivers(orderId: string): Promise<{ city: string | null; options: DriverOption[] }> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!order) return { city: null, options: [] }
  const [address] = await db.select({ city: addresses.city }).from(addresses).where(eq(addresses.id, order.pickupAddressId)).limit(1)
  const pickupCity = address?.city ?? ""
  const assignments = await db.select({ details: relatedRecords.details }).from(relatedRecords).where(eq(relatedRecords.collection, "work_assignments"))
  const busy = new Set(assignments.filter((row) => ["ASSIGNED", "IN_PROGRESS"].includes(String(row.details.status))).map((row) => String(row.details.driver_id)))
  const pool = (await db.select().from(drivers)).filter((driver) => driver.homeCity === pickupCity && !busy.has(driver.id) && driver.details.active !== false)
  const chosen = pool.sort((a, b) => hash(`${orderId}|${a.id}`) - hash(`${orderId}|${b.id}`)).slice(0, 3)
  return {
    city: pickupCity || null,
    options: chosen.map((driver) => ({ id: driver.id, name: driver.displayName, home: `${driver.homeCity}, ${driver.homeCountry}`, note: "lives in the pickup city; no other gig in the records; has not been asked yet" })),
  }
}
