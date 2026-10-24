// The mocked disruption feed (fictional): strikes, protests and road closures, each
// with the source that reported it. Code matches an active notice against orders'
// routes and drivers' booked travel; the Monitor turns a match into an Investigator
// run before any driver reports anything. A notice is a signal, not a confirmed fact.

import { and, eq, isNotNull, lte, gte } from "drizzle-orm"
import type { CaseFile } from "./case"
import { db } from "./db"
import { cityAt, distanceToLegKm } from "./geo"
import { disruptions, type DisruptionScope } from "./schema"
import { at, range } from "./time"

export type Disruption = typeof disruptions.$inferSelect

/** Three fictional notices. The Lille protest is not in the feed until the demo publishes it. */
export const SEED_DISRUPTIONS: (typeof disruptions.$inferInsert)[] = [
  {
    id: "dis-de-rail-strike", kind: "strike", region: "Germany, long-distance and regional rail",
    title: "Rail strike in Germany",
    detail: "Train drivers' union strike on long-distance and regional trains across Germany. Most trains will not run; replacement buses on a few regional lines only.",
    startsAt: new Date("2026-10-22T02:00:00Z"), endsAt: new Date("2026-10-23T02:00:00Z"), timezone: "Europe/Berlin",
    sourceLabel: "Rail operator notice", affects: { modes: ["train"], countries: ["DE"] }, publishedAt: new Date("2026-10-20T16:00:00Z"),
  },
  {
    id: "dis-fr-lille-protest", kind: "protest", region: "Lille area, France: A1, A25 and the ring road",
    title: "Farmers' protest blocking roads around Lille",
    detail: "Tractor blockades on the A1 and A25 and at the Lille ring road junctions. Traffic into and around Lille may be stopped for hours; police advise avoiding the area.",
    startsAt: new Date("2026-10-22T04:00:00Z"), endsAt: new Date("2026-10-27T19:00:00Z"), timezone: "Europe/Paris",
    sourceLabel: "Regional traffic service", affects: { modes: ["road"], near: { city: "Lille", lat: 50.63, lon: 3.06, radiusKm: 35 } }, publishedAt: null,
  },
  {
    id: "dis-fi-e18-closure", kind: "road_closure", region: "E18 between Kotka and Hamina, Finland",
    title: "E18 closed between Kotka and Hamina",
    detail: "Night closure for bridge works in both directions. Detour on road 7 adds about 20 minutes.",
    startsAt: new Date("2026-10-21T18:00:00Z"), endsAt: new Date("2026-10-22T02:00:00Z"), timezone: "Europe/Helsinki",
    sourceLabel: "Regional traffic service", affects: { modes: ["road"], near: { city: "Kotka", lat: 60.47, lon: 26.95, radiusKm: 25 } }, publishedAt: new Date("2026-10-21T06:30:00Z"),
  },
]

export async function seedDisruptions(): Promise<number> {
  for (const row of SEED_DISRUPTIONS) {
    await db.insert(disruptions).values(row).onConflictDoUpdate({ target: disruptions.id, set: row })
  }
  return SEED_DISRUPTIONS.length
}

/** Published notices that have not ended. */
export async function activeDisruptions(now: Date): Promise<Disruption[]> {
  return db.select().from(disruptions).where(and(isNotNull(disruptions.publishedAt), lte(disruptions.publishedAt, now), gte(disruptions.endsAt, now)))
}

export const KIND_WORD: Record<string, string> = { strike: "Strike", protest: "Protest", road_closure: "Road closure" }

/** "Rail strike in Germany, Thu 22 Oct 04:00 – Fri 23 Oct 04:00 CEST. Reported by Rail operator notice, Tue 20 Oct 18:00 CEST." */
export function noticeLine(d: Disruption): string {
  return `${d.title}, ${range(d.startsAt, d.endsAt, d.timezone)}. ${d.detail} Reported by ${d.sourceLabel}${d.publishedAt ? `, ${at(d.publishedAt, d.timezone)}` : ""}.`
}

export type Match = { file: CaseFile; effect: string; why: "route" | "pickup" | "delivery" | "train" }

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart <= bEnd && bStart <= aEnd

/**
 * The orders a notice touches, with what it does to each, in plain words built from the records.
 * Road: an active order whose pickup, delivery or road leg lies in the area while the notice runs. Orders planned
 * to pass there in the window count, not only cars already on the road.
 * Train: a driver's booked train that departs inside the notice's window in an affected country.
 */
export function matchDisruption(d: Disruption, files: CaseFile[], now: Date): Match[] {
  const scope = d.affects as DisruptionScope
  const start = d.startsAt.getTime()
  const end = d.endsAt.getTime()
  const out: Match[] = []
  for (const file of files) {
    const { order } = file
    if (order.stage.key === "delivered" || order.stage.key === "cancelled") continue
    const driver = order.driver ? `${order.driver.name} has not reported anything about it` : "No driver is booked yet"
    if (scope.modes.includes("train")) {
      for (const time of file.keyTimes.filter((item) => item.key === "driver_travel" && item.label === "Driver's train")) {
        const departs = new Date(time.start).getTime()
        const [from, to] = (time.note ?? "").split(" to ")
        const inCountry = [cityAt(from), cityAt(to)].some((city) => city && scope.countries?.includes(city.country))
        if (departs >= start && departs <= end && inCountry) {
          out.push({ file, why: "train", effect: `The driver's train ${from} to ${to}, ${at(time.start, time.zone)}, departs during the ${d.kind === "strike" ? "strike" : "disruption"} (${range(d.startsAt, d.endsAt, d.timezone)}). ${driver}.` })
          break
        }
      }
    }
    if (scope.modes.includes("road") && scope.near) {
      const near = scope.near
      const pickup = file.keyTimes.find((item) => item.key === "pickup_slot" || item.key === "pickup_planned")
      const delivery = file.keyTimes.find((item) => item.key === "delivery_promise")
      const from = cityAt(order.route.from?.city)
      const to = cityAt(order.route.to?.city)
      const via = cityAt(order.route.via?.city)
      const travelStart = order.pickedUpAt ? now.getTime() : pickup ? new Date(pickup.start).getTime() : now.getTime()
      const travelEnd = delivery ? new Date(delivery.end ?? delivery.start).getTime() : travelStart + 3 * 86_400_000
      if (!overlaps(travelStart, travelEnd, start, end)) continue
      const close = (city: typeof from) => !!city && distanceToLegKm(near, city, city) <= near.radiusKm
      const name = near.city
      if (close(to) && delivery && overlaps(new Date(delivery.start).getTime(), travelEnd, start, end)) {
        out.push({ file, why: "delivery", effect: `Delivery in ${order.route.to?.city ?? name}, ${range(delivery.start, delivery.end, delivery.zone)}, falls inside the ${d.kind === "protest" ? "protest" : "closure"} near ${name}. ${driver}.` })
      } else if (close(from) && pickup && overlaps(new Date(pickup.start).getTime(), new Date(pickup.end ?? pickup.start).getTime(), start, end)) {
        out.push({ file, why: "pickup", effect: `Pickup in ${order.route.from?.city ?? name}, ${range(pickup.start, pickup.end, pickup.zone)}, falls inside the ${d.kind === "protest" ? "protest" : "closure"} near ${name}. ${driver}.` })
      } else {
        const legs = [from, via, to].filter((city): city is NonNullable<typeof from> => !!city)
        const km = legs.slice(1).map((city, index) => distanceToLegKm(near, legs[index], city))
        const closest = km.length ? Math.min(...km) : Infinity
        if (closest <= near.radiusKm) out.push({ file, why: "route", effect: `The road from ${order.route.from?.city} to ${order.route.to?.city} passes about ${Math.round(closest)} km from ${name} while it runs. ${driver}.` })
      }
    }
  }
  return out
}

export async function getDisruption(id: string): Promise<Disruption | null> {
  const [row] = await db.select().from(disruptions).where(eq(disruptions.id, id)).limit(1)
  return row ?? null
}
