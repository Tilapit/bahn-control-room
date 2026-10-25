// Who is on shift, and who has which order. "You" is the person using the app ("Ops" in the records); the two
// colleagues are fictional, like every name here, and their claims are seeded with the recorded morning so For you
// can show what a team looks like: one colleague working on an order, one whose claim has gone quiet.

import { and, count, desc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { writeEntry } from "./agents/entries"
import { now as clockNow } from "./clock"
import { db } from "./db"
import { agentRuns, cards, orders, takeovers, timelineEntries } from "./schema"

import { COLLEAGUES, YOU } from "./people"

export { COLLEAGUES, initialsOf, isStale, personWords, quietMinutes, STALE_MINUTES, YOU, type Colleague } from "./people"

/**
 * Seed the colleagues' claims on the recorded morning: a takeover in their name, back-dated by `minutesAgo` on the
 * simulated clock, with its timeline entry. Skipped for an order someone already holds. Idempotent.
 */
export async function seedShift(): Promise<number> {
  const at = await clockNow()
  let seeded = 0
  for (const colleague of COLLEAGUES) {
    if (!colleague.claim) continue
    const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.reference, colleague.claim.reference)).limit(1)
    if (!order) continue
    const [open] = await db.select({ id: takeovers.id }).from(takeovers).where(and(eq(takeovers.orderId, order.id), isNull(takeovers.handedBackAt))).limit(1)
    if (open) continue
    const takenAt = new Date(at.getTime() - colleague.claim.minutesAgo * 60_000)
    const id = `tko_${randomUUID().slice(0, 12)}`
    await db.insert(takeovers).values({ id, orderId: order.id, takenAt, takenBy: colleague.name })
    await writeEntry({
      orderId: order.id, at: takenAt, source: "person", channel: "takeover", authorType: "operator", authorLabel: colleague.name, kind: "event", status: "done",
      summary: `${colleague.name} took this order over (fictional colleague, seeded with the recorded morning)`,
      evidence: { table: "takeovers", id },
    })
    seeded += 1
  }
  return seeded
}

/** The last thing each claimer did on their order since claiming it: the newest timeline entry in their name. */
export async function lastActivity(claims: { orderId: string; takenAt: Date; takenBy: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!claims.length) return out
  const rows = await db.select({ orderId: timelineEntries.orderId, at: timelineEntries.occurredAt, by: timelineEntries.authorLabel, channel: timelineEntries.channel })
    .from(timelineEntries).where(and(inArray(timelineEntries.orderId, claims.map((claim) => claim.orderId)), eq(timelineEntries.source, "person")))
  for (const claim of claims) {
    const mine = rows.filter((row) => row.orderId === claim.orderId && row.by === claim.takenBy && row.channel !== "takeover" && row.at >= claim.takenAt)
    const newest = mine.map((row) => row.at.getTime()).sort((a, b) => b - a)[0]
    if (newest) out.set(claim.orderId, new Date(newest).toISOString())
  }
  return out
}

export type ShiftMember = { name: string; initials: string; tone: string; status: string }
export type RailCounts = { orders: number; working: number; handledToday: number; shift: ShiftMember[] }

/** The rail's numbers, all from the records: orders, agents at work, updates handled today without a person, who is on shift. */
export async function railCounts(): Promise<RailCounts> {
  const at = await clockNow()
  // The day on the desk's clock (Helsinki), from its midnight.
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki", year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
  const midnight = new Date(`${day}T00:00:00+03:00`)
  const runsWithCard = db.select({ id: cards.runId }).from(cards).where(sql`${cards.runId} is not null`)
  const [[orderRow], [workingRow], [handledRow], open] = await Promise.all([
    db.select({ n: count() }).from(orders),
    db.select({ n: count() }).from(agentRuns).where(inArray(agentRuns.status, ["running", "waiting_driver", "waiting_site"])),
    db.select({ n: count() }).from(agentRuns).where(and(gte(agentRuns.startedAt, midnight), eq(agentRuns.status, "done"), notInArray(agentRuns.id, runsWithCard))),
    db.select({ takenBy: takeovers.takenBy, n: count() }).from(takeovers).where(isNull(takeovers.handedBackAt)).groupBy(takeovers.takenBy).orderBy(desc(count())),
  ])
  const held = new Map(open.map((row) => [row.takenBy, row.n]))
  const orderWords = (n: number) => n ? `${n} order${n === 1 ? "" : "s"}` : "free"
  const shift: ShiftMember[] = [
    { name: "You", initials: "Y", tone: "green", status: orderWords(held.get(YOU) ?? 0) },
    ...COLLEAGUES.map((colleague) => ({ name: colleague.name, initials: colleague.initials, tone: colleague.tone, status: colleague.awayMinutes ? `away ${colleague.awayMinutes} min` : orderWords(held.get(colleague.name) ?? 0) })),
  ]
  return { orders: orderRow?.n ?? 0, working: workingRow?.n ?? 0, handledToday: handledRow?.n ?? 0, shift }
}
