// The For you queue: open cards, each with its order and the consequence that
// sorts it. Urgency is computed now, against the simulated clock, not stored.

import { count, eq, inArray } from "drizzle-orm"
import { type CaseFile, getCases } from "./case"
import { now as clockNow } from "./clock"
import { db } from "./db"
import { agentRuns, cards } from "./schema"
import type { CardFinding, CardOption, CardProposal } from "./schema"
import { liveSignals } from "./signals"
import { compareUrgency, type Urgency, urgency } from "./urgency"

export type QueueCard = {
  id: string
  kind: string
  origin: string
  runId: string | null
  headline: string
  whatHappened: string
  findings: CardFinding[]
  proposal: CardProposal | null
  options: CardOption[]
  severity: "safety" | "high" | "normal"
}

export type QueueOrder = {
  id: string
  reference: string
  car: string
  route: string
  /** Zone used for times on this order: pickup until the car is collected, then delivery. */
  zone: string | null
}

export type QueueItem = { card: QueueCard; order: QueueOrder; urgency: Urgency }

export type QueueCounts = {
  needYou: number
  /** Orders with a live signal and an agent run, but no card for a person. */
  handling: number
  /** Orders with a live signal that no agent has looked at yet. */
  unattended: number
  /** Orders with nothing open. */
  quiet: number
  total: number
}

export function orderView(file: CaseFile): QueueOrder {
  const { order } = file
  const from = order.route.from?.city ?? "?"
  const to = order.route.to?.city ?? "?"
  const collected = !!order.pickedUpAt || order.stage.key === "delivered"
  return {
    id: order.id, reference: order.reference, car: order.car.label,
    route: order.route.via ? `${from} → ${order.route.via.city} → ${to}` : `${from} → ${to}`,
    zone: (collected ? order.route.to?.zone : order.route.from?.zone) ?? null,
  }
}

export function toQueueCard(row: typeof cards.$inferSelect): QueueCard {
  return {
    id: row.id, kind: row.kind, origin: row.origin, runId: row.runId, headline: row.headline, whatHappened: row.whatHappened,
    findings: row.findings, proposal: row.proposal ?? null, options: row.options, severity: row.severity as QueueCard["severity"],
  }
}

export async function getQueue(): Promise<{ now: string; items: QueueItem[]; counts: QueueCounts }> {
  const at = await clockNow()
  const [openCards, files, runs] = await Promise.all([
    db.select().from(cards).where(eq(cards.status, "open")),
    getCases(),
    db.selectDistinct({ orderId: agentRuns.orderId }).from(agentRuns),
  ])
  const byOrder = new Map(files.map((file) => [file.order.id, file]))
  const items: QueueItem[] = []
  for (const row of openCards) {
    const file = byOrder.get(row.orderId)
    if (!file) continue
    items.push({ card: toQueueCard(row), order: orderView(file), urgency: urgency(file, at) })
  }
  items.sort((a, b) => compareUrgency(a.urgency, b.urgency))

  const withCard = new Set(items.map((item) => item.order.id))
  const withRun = new Set(runs.map((run) => run.orderId))
  let handling = 0
  let unattended = 0
  for (const file of files) {
    if (withCard.has(file.order.id) || !liveSignals(file).length) continue
    if (withRun.has(file.order.id)) handling += 1
    else unattended += 1
  }
  const needYou = withCard.size
  return {
    now: at.toISOString(),
    items,
    counts: { needYou, handling, unattended, quiet: files.length - needYou - handling - unattended, total: files.length },
  }
}

/** Open cards for the rail badge. */
export async function openCardCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(cards).where(eq(cards.status, "open"))
  return row?.n ?? 0
}

/** Open cards on one order, as queue items, for the order page. */
export async function cardsForOrder(file: CaseFile, at: Date): Promise<QueueItem[]> {
  const rowsFound = await db.select().from(cards).where(inArray(cards.orderId, [file.order.id]))
  return rowsFound.filter((row) => row.status === "open").map((row) => ({ card: toQueueCard(row), order: orderView(file), urgency: urgency(file, at) }))
}
