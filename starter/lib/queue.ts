// The For you queue: open cards, each with its order and the consequence that
// sorts it. Urgency is computed now, against the simulated clock, not stored.

import { and, count, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm"
import { type CaseFile, getCases, orderCount, ordersWithOpenItems } from "./case"
import { now as clockNow } from "./clock"
import { db } from "./db"
import { agentRuns, agentSteps, cards, decisions, timelineEntries } from "./schema"
import type { CardFinding, CardGroupItem, CardOption, CardProposal, VerifierNote } from "./schema"
import { liveSignals } from "./signals"
import { openTakeovers } from "./takeover"
import { orderRoutes, teamOf } from "./team-data"
import type { Team } from "./teams"
import { compareUrgency, type Urgency, urgency, withProposalDeadline } from "./urgency"

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

/**
 * `takenOver`: Ops is handling the order themselves; agents are paused on it until it is handed back.
 * `team`: the customer's market, the countries the route touches and the card's desk, for the team views (lib/teams.ts).
 */
export type QueueItem = { card: QueueCard; order: QueueOrder; urgency: Urgency; takenOver: { at: string; by: string } | null; team: Team }

/** Now: a person's safety, or something lost within 4 hours or already lost. Everything else waits under Later. */
export const isNowItem = (item: Pick<QueueItem, "urgency">) => item.urgency.safety || item.urgency.timeRisk

export type QueueCounts = {
  needYou: number
  /** Orders a person took over: theirs until they hand them back. Counted inside needYou too. */
  yours: number
  /** Orders with a live signal and an agent run, but no card for a person. */
  handling: number
  /** Orders with a live signal that no agent has looked at yet. */
  unattended: number
  /** Orders with a live signal whose card a person decided today: the next step is theirs or the Executor's, not an agent's. */
  decided: number
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

/** The option a card leads with: its first one that is not a rejection or an answer. */
function primaryOption(options: CardOption[]): CardOption | null {
  return options.find((option) => option.kind !== "reject" && option.kind !== "answer") ?? null
}

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

export type YoursWithoutCard = { order: QueueOrder; takenOver: { at: string; by: string }; open: string[] }

export async function getQueue(): Promise<{ now: string; items: QueueItem[]; counts: QueueCounts; yoursWithoutCard: YoursWithoutCard[] }> {
  const at = await clockNow()
  // Only orders with something open, an agent still watching or a decision of the last day can need anyone;
  // the rest are counted, not compiled (1,000 orders in scale mode).
  const [openCards, openIds, total, ordersWithRun, ruleRows, decidedRows, taken] = await Promise.all([
    db.select().from(cards).where(eq(cards.status, "open")),
    ordersWithOpenItems(),
    orderCount(),
    // Only agents that work a case count as handling it: not the Classifier reading messages, not a quiet check.
    db.selectDistinct({ orderId: agentRuns.orderId, nextCheckAt: agentRuns.nextCheckAt, status: agentRuns.status }).from(agentRuns).where(inArray(agentRuns.agent, HANDLING_AGENTS)),
    db.select({ n: count() }).from(decisions).where(eq(decisions.actor, "Agent, under your rule")),
    db.select({ orderId: cards.orderId, group: cards.group }).from(decisions).innerJoin(cards, eq(cards.id, decisions.cardId))
      .where(and(isNull(decisions.undoneAt), gte(decisions.decidedAt, new Date(at.getTime() - 24 * 3600_000)), sql`${decisions.actor} <> 'Agent, under your rule'`)),
    openTakeovers(),
  ])
  const takenOver = new Map(taken.map((row) => [row.orderId, { at: row.takenAt.toISOString(), by: row.takenBy }]))
  // An agent that finished but looks again later is still handling the order, signal or not (Agents shows it as "Watching").
  const watching = new Set(ordersWithRun.filter((run) => run.status === "done" && run.nextCheckAt && run.nextCheckAt > at).map((run) => run.orderId))
  const decidedByYou = new Set(decidedRows.flatMap((row) => [row.orderId, ...(row.group ?? []).map((member) => member.order_id)]))
  const ids = [...new Set([...openIds, ...watching, ...decidedByYou, ...takenOver.keys()].filter((id): id is string => !!id))]
  const files = ids.length ? await getCases(ids) : []
  const byOrder = new Map(files.map((file) => [file.order.id, file]))
  const runs = await runInfo(openCards.map((row) => row.runId))
  const items: QueueItem[] = []
  for (const row of openCards) {
    const file = byOrder.get(row.orderId)
    if (!file) continue
    items.push({ card: toQueueCard(row, runs), order: orderView(file), urgency: withProposalDeadline(urgency(file, at), primaryOption(row.options), at), takenOver: takenOver.get(row.orderId) ?? null, team: teamOf(undefined, row, file) })
  }
  items.sort((a, b) => compareUrgency(a.urgency, b.urgency))
  await withChannels(items)
  await withTeams(items, byOrder)

  const withCard = new Set(items.flatMap((item) => [item.order.id, ...(item.card.group ?? []).map((member) => member.order_id)]))
  const withRun = new Set(ordersWithRun.map((run) => run.orderId))
  let handling = 0
  let unattended = 0
  let decided = 0
  // A taken-over order with no card is still the person's: it is listed under Yours with what is open on it.
  let yoursWithoutCard = 0
  for (const file of files) {
    if (takenOver.has(file.order.id) && !withCard.has(file.order.id)) { yoursWithoutCard += 1; continue }
    if (withCard.has(file.order.id) || (!liveSignals(file).length && !watching.has(file.order.id))) continue
    // An order whose card a person just decided is not "handled by agents": the call or the booking is theirs now.
    if (decidedByYou.has(file.order.id)) decided += 1
    else if (withRun.has(file.order.id)) handling += 1
    else unattended += 1
  }
  const needYou = withCard.size + yoursWithoutCard
  return {
    now: at.toISOString(),
    items,
    counts: { needYou, yours: takenOver.size, handling, unattended, decided, quiet: total - needYou - handling - unattended - decided, total, byRule: ruleRows[0]?.n ?? 0 },
    yoursWithoutCard: files.filter((file) => takenOver.has(file.order.id) && !withCard.has(file.order.id)).map((file) => ({ order: orderView(file), takenOver: takenOver.get(file.order.id)!, open: liveSignals(file) })),
  }
}

export type Holding = "card" | "decided" | "agent" | "unattended" | "taken"

/**
 * Who has each order with something open, by the same rules as For you's header: a card waits for a person, a person
 * decided it in the last day, an agent works on it or watches it, or nobody has looked yet. Orders not in the map have
 * nothing open. Compiles only the orders that can have something open (the rest are counted, not compiled).
 */
export async function holdings(at: Date): Promise<{ files: CaseFile[]; cardOf: Map<string, typeof cards.$inferSelect>; holding: Map<string, Holding> }> {
  const [openCards, openIds, ordersWithRun, decidedRows] = await Promise.all([
    db.select().from(cards).where(eq(cards.status, "open")),
    ordersWithOpenItems(),
    db.selectDistinct({ orderId: agentRuns.orderId, nextCheckAt: agentRuns.nextCheckAt, status: agentRuns.status }).from(agentRuns).where(inArray(agentRuns.agent, HANDLING_AGENTS)),
    db.select({ orderId: cards.orderId, group: cards.group }).from(decisions).innerJoin(cards, eq(cards.id, decisions.cardId))
      .where(and(isNull(decisions.undoneAt), gte(decisions.decidedAt, new Date(at.getTime() - 24 * 3600_000)), sql`${decisions.actor} <> 'Agent, under your rule'`)),
  ])
  const cardOf = new Map(openCards.flatMap((row) => [row.orderId, ...(row.group ?? []).map((member) => member.order_id)].map((id) => [id, row] as const)))
  const watching = new Set(ordersWithRun.filter((run) => run.status === "done" && run.nextCheckAt && run.nextCheckAt > at).map((run) => run.orderId))
  const withRun = new Set(ordersWithRun.map((run) => run.orderId))
  const decidedByYou = new Set(decidedRows.flatMap((row) => [row.orderId, ...(row.group ?? []).map((member) => member.order_id)]))
  const taken = new Set((await openTakeovers()).map((row) => row.orderId))
  const ids = [...new Set([...openIds, ...watching, ...decidedByYou, ...cardOf.keys(), ...taken].filter((id): id is string => !!id))]
  const files = ids.length ? await getCases(ids) : []
  const holding = new Map<string, Holding>()
  for (const file of files) {
    const id = file.order.id
    if (taken.has(id)) holding.set(id, "taken")
    else if (cardOf.has(id)) holding.set(id, "card")
    else if (!liveSignals(file).length && !watching.has(id)) continue
    else holding.set(id, decidedByYou.has(id) ? "decided" : withRun.has(id) ? "agent" : "unattended")
  }
  return { files, cardOf, holding }
}

/** Each finding's channel (driver chat, GPS, a booking…), from the record it cites, so the card shows its source icon. */
async function withChannels(items: QueueItem[]): Promise<QueueItem[]> {
  const ids = [...new Set(items.flatMap((item) => item.card.findings.map((finding) => finding.source_entry_id)))]
  if (!ids.length) return items
  const rows = await db.select({ id: timelineEntries.id, source: timelineEntries.source }).from(timelineEntries).where(inArray(timelineEntries.id, ids))
  const channel = new Map(rows.map((row) => [row.id, row.source]))
  for (const item of items) item.card.findings = item.card.findings.map((finding) => ({ ...finding, channel: channel.get(finding.source_entry_id) ?? null }))
  return items
}

/** Open cards for the rail badge. */
/** The rail badge: the team of every card that needs someone now (not taken over), so the badge can follow a view. */
export async function nowTeams(): Promise<Team[]> {
  const { items } = await getQueue()
  return items.filter((item) => !item.takenOver && isNowItem(item)).map((item) => item.team)
}

/** Open cards on one order, as queue items, for the order page. */
export async function cardsForOrder(file: CaseFile, at: Date): Promise<QueueItem[]> {
  // A card for several orders shows on each of them.
  const rowsFound = (await db.select().from(cards).where(and(eq(cards.status, "open"), or(eq(cards.orderId, file.order.id), sql`${cards.group} @> ${JSON.stringify([{ order_id: file.order.id }])}::jsonb`))))
  const [runs, [taken]] = await Promise.all([runInfo(rowsFound.map((row) => row.runId)), openTakeovers([file.order.id])])
  const takenOver = taken ? { at: taken.takenAt.toISOString(), by: taken.takenBy } : null
  const items = rowsFound.map((row) => ({ card: toQueueCard(row, runs), order: orderView(file), urgency: withProposalDeadline(urgency(file, at), primaryOption(row.options), at), takenOver, team: teamOf(undefined, row, file) }))
  return withTeams(await withChannels(items), new Map([[file.order.id, file]]))
}

/**
 * Each card's market and route, from the records: the lead order's customer, and every country any of its orders
 * passes through (one card can cover several orders). The desk was set from the card when the item was built.
 */
async function withTeams(items: QueueItem[], files: Map<string, CaseFile>): Promise<QueueItem[]> {
  const ids = [...new Set(items.flatMap((item) => [item.order.id, ...(item.card.group ?? []).map((member) => member.order_id)]))]
  if (!ids.length) return items
  const routes = await orderRoutes(ids)
  for (const item of items) {
    const lead = routes.get(item.order.id)
    const members = (item.card.group ?? []).map((member) => routes.get(member.order_id)).filter((route) => !!route)
    const countries = [...new Set([...(lead?.countries ?? []), ...members.flatMap((route) => route.countries)])]
    const team = teamOf(lead, null, files.get(item.order.id) ?? null)
    item.team = { ...team, countries, crossBorder: team.crossBorder || members.some((route) => route.crossBorder || route.market !== team.market), desk: item.team.desk }
  }
  return items
}
