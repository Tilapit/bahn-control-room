// The For you queue: open cards, each with its order and the consequence that
// sorts it. Urgency is computed now, against the simulated clock, not stored.

import { and, count, eq, inArray, notInArray, or, sql } from "drizzle-orm"
import { type CaseFile, getCases } from "./case"
import { now as clockNow } from "./clock"
import { db } from "./db"
import { agentRuns, agentSteps, cards, decisions } from "./schema"
import type { CardFinding, CardGroupItem, CardOption, CardProposal, VerifierNote } from "./schema"
import { liveSignals } from "./signals"
import { compareUrgency, type Urgency, urgency } from "./urgency"

const HANDLING_AGENTS = ["Investigator", "Driver support"]

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
  verifierNotes: VerifierNote[] | null
  /** One cause, several orders: each order the card covers, with what the cause does to it. */
  group: CardGroupItem[] | null
  /** The agent run that wrote the card: model, effort and cost, shown in one quiet line. */
  run: { model: string | null; steps: number; tokens: number; costUsd: number; escalation: string | null } | null
}

export type QueueOrder = {
  id: string
  reference: string
  car: string
  customer: string
  route: string
  /** Zone used for times on this order: pickup until the car is collected, then delivery. */
  zone: string | null
  /** The pickup's and the delivery's own zones, for a proposed new time at either end. */
  zones: { pickup: string | null; delivery: string | null }
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
  /** Actions agents carried out without asking, under a rule a person set. */
  byRule: number
}

/** "Munich → Hamburg → Lahti"; a transfer yard in the delivery city is not a third stop; one city at both ends is "Within Helsinki". */
export function routeWords(from: string, via: string | null, to: string): string {
  if (from === to && (!via || via === to)) return `Within ${from}`
  return via && via !== from && via !== to ? `${from} → ${via} → ${to}` : `${from} → ${to}`
}

export function orderView(file: CaseFile): QueueOrder {
  const { order } = file
  const from = order.route.from?.city ?? "?"
  const to = order.route.to?.city ?? "?"
  const collected = !!order.pickedUpAt || order.stage.key === "delivered"
  return {
    id: order.id, reference: order.reference, car: order.car.label, customer: order.customer.name,
    route: routeWords(from, order.route.via?.city ?? null, to),
    zone: (collected ? order.route.to?.zone : order.route.from?.zone) ?? null,
    zones: { pickup: order.route.from?.zone ?? null, delivery: order.route.to?.zone ?? null },
  }
}

type RunInfo = NonNullable<QueueCard["run"]>

export function toQueueCard(row: typeof cards.$inferSelect, runs: Map<string, RunInfo> = new Map()): QueueCard {
  return {
    id: row.id, kind: row.kind, origin: row.origin, runId: row.runId, headline: row.headline, whatHappened: row.whatHappened,
    findings: row.findings, proposal: row.proposal ?? null, options: row.options, severity: row.severity as QueueCard["severity"],
    verifierNotes: row.verifierNotes ?? null, run: row.runId ? runs.get(row.runId) ?? null : null, group: row.group ?? null,
  }
}

/** Model, steps, tokens and cost of the runs behind these cards. */
async function runInfo(runIds: (string | null)[]): Promise<Map<string, RunInfo>> {
  const ids = [...new Set(runIds.filter((id): id is string => !!id))]
  if (!ids.length) return new Map()
  const [runRows, stepRows] = await Promise.all([
    db.select().from(agentRuns).where(inArray(agentRuns.id, ids)),
    db.select({ runId: agentSteps.runId, n: count() }).from(agentSteps).where(and(inArray(agentSteps.runId, ids), eq(agentSteps.type, "tool_call"), notInArray(agentSteps.tool, ["add_finding", "add_step", "add_affected_order"]))).groupBy(agentSteps.runId),
  ])
  const steps = new Map(stepRows.map((row) => [row.runId, row.n]))
  return new Map(runRows.map((run) => [run.id, {
    model: run.model, steps: steps.get(run.id) ?? 0, costUsd: run.costUsd, escalation: run.escalation,
    tokens: run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens,
  }]))
}

export async function getQueue(): Promise<{ now: string; items: QueueItem[]; counts: QueueCounts }> {
  const at = await clockNow()
  const [openCards, files, ordersWithRun, ruleRows] = await Promise.all([
    db.select().from(cards).where(eq(cards.status, "open")),
    getCases(),
    // Only agents that work a case count as handling it: not the Classifier reading messages, not a quiet check.
    db.selectDistinct({ orderId: agentRuns.orderId }).from(agentRuns).where(inArray(agentRuns.agent, HANDLING_AGENTS)),
    db.select({ n: count() }).from(decisions).where(eq(decisions.actor, "Agent, under your rule")),
  ])
  const byOrder = new Map(files.map((file) => [file.order.id, file]))
  const runs = await runInfo(openCards.map((row) => row.runId))
  const items: QueueItem[] = []
  for (const row of openCards) {
    const file = byOrder.get(row.orderId)
    if (!file) continue
    items.push({ card: toQueueCard(row, runs), order: orderView(file), urgency: urgency(file, at) })
  }
  items.sort((a, b) => compareUrgency(a.urgency, b.urgency))

  const withCard = new Set(items.flatMap((item) => [item.order.id, ...(item.card.group ?? []).map((member) => member.order_id)]))
  const withRun = new Set(ordersWithRun.map((run) => run.orderId))
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
    counts: { needYou, handling, unattended, quiet: files.length - needYou - handling - unattended, total: files.length, byRule: ruleRows[0]?.n ?? 0 },
  }
}

/** Open cards for the rail badge. */
export async function openCardCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(cards).where(eq(cards.status, "open"))
  return row?.n ?? 0
}

/** Open cards on one order, as queue items, for the order page. */
export async function cardsForOrder(file: CaseFile, at: Date): Promise<QueueItem[]> {
  // A card for several orders shows on each of them.
  const rowsFound = (await db.select().from(cards).where(and(eq(cards.status, "open"), or(eq(cards.orderId, file.order.id), sql`${cards.group} @> ${JSON.stringify([{ order_id: file.order.id }])}::jsonb`))))
  const runs = await runInfo(rowsFound.map((row) => row.runId))
  return rowsFound.map((row) => ({ card: toQueueCard(row, runs), order: orderView(file), urgency: urgency(file, at) }))
}
