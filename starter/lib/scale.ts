// Scale mode (demo). The dataset has 100 orders; a real desk has hundreds open at once. This adds 900 synthetic
// copies of the dataset's quiet orders, with new references (CD-430001 to CD-430900), so the app can be seen with
// 1,000 orders. Fictional like the rest. A copy keeps its template's records with new ids, a new plate and VIN, and
// says which order it was copied from. Only orders that are quiet now, and that no Monitor rule or disruption notice
// would touch in the next 24 simulated hours, are copied: the copies add to "nothing open on N", never to For you.

import { createHash } from "node:crypto"
import { inArray, isNull, sql } from "drizzle-orm"
import { type CaseFile, getCases } from "./case"
import { demoStart, now as clockNow } from "./clock"
import { db } from "./db"
import { type Disruption, matchDisruption, SEED_DISRUPTIONS } from "./disruptions"
import { silentSignal } from "./monitor"
import { QUIET_AGENT, QUIET_STEP, QUIET_TRIGGER, quietOutcome } from "./quiet-check"
import {
  addresses, agentRuns, agentSteps, alerts, conversations, customers, drivers, facts, messages, operationalEvents, orderItems, orders,
  relatedRecords, searchDocuments, sites, timelineEntries, vehicles,
} from "./schema"
import { liveSignals } from "./signals"
import { buildTimeline } from "./timeline/build"

export const SCALE_TOTAL = 1000
const FIRST_NUMBER = 430001
const HOUR = 3_600_000
/** Orders the demo scenarios and the prompt-injection test play with: their copies would only confuse a demo. */
const DEMO_ORDERS = new Set(["CD-420299", "CD-420322", "CD-420576", "CD-420692", "CD-420697", "CD-420442", "CD-420145", "CD-420603", "CD-420405", "CD-420123"])
/** Copies are marked in orders.details; every other table finds them through the order id. */
const SYNTHETIC = sql`(select id from orders where details ? 'synthetic_of')`

export type ScaleState = { on: boolean; total: number; synthetic: number }

export async function scaleState(): Promise<ScaleState> {
  const [row] = await db.execute<{ total: number; synthetic: number }>(sql`select count(*)::int as total, (count(*) filter (where details ? 'synthetic_of'))::int as synthetic from orders`)
  return { on: (row?.synthetic ?? 0) > 0, total: row?.total ?? 0, synthetic: row?.synthetic ?? 0 }
}

/** Every notice in the feed, as if it were published: a copy must stay clear of the unpublished Lille protest too. */
const NOTICES = SEED_DISRUPTIONS.map((row) => ({ ...row, publishedAt: row.publishedAt ?? row.startsAt }) as Disruption)

/** Quiet now and for the next 24 simulated hours: no live signal, no card, no Monitor rule and no disruption notice touches it. */
export function staysQuiet(file: CaseFile, from: Date, recordedUntil: number): boolean {
  if (liveSignals(file).length || file.open.cards.length) return false
  for (let hour = 0; hour <= 24; hour += 1) {
    const at = new Date(from.getTime() + hour * HOUR)
    if (silentSignal(file, at, Math.min(at.getTime(), recordedUntil))) return false
    if (NOTICES.some((notice) => matchDisruption(notice, [file], at).length)) return false
  }
  return true
}

type Row = Record<string, unknown>
type TemplateRows = {
  order: typeof orders.$inferSelect
  items: (typeof orderItems.$inferSelect)[]
  vehicles: (typeof vehicles.$inferSelect)[]
  addresses: (typeof addresses.$inferSelect)[]
  conversations: (typeof conversations.$inferSelect)[]
  messages: (typeof messages.$inferSelect)[]
  alerts: (typeof alerts.$inferSelect)[]
  events: (typeof operationalEvents.$inferSelect)[]
  related: (typeof relatedRecords.$inferSelect)[]
}

/** Every id the template's own records carry. A copy gets each with a suffix; shared records (customers, sites, drivers) keep theirs. */
function ownIds(template: TemplateRows): string[] {
  return [
    template.order.id, ...template.items.map((row) => row.id), ...template.vehicles.map((row) => row.id), ...template.addresses.map((row) => row.id),
    ...template.conversations.map((row) => row.id), ...template.messages.map((row) => row.id), ...template.alerts.map((row) => row.id),
    ...template.events.map((row) => row.id), ...template.related.map((row) => row.id),
  ]
}

/** The same value with every own id replaced, and the template's reference, plate and VIN replaced inside text. */
function remap(value: unknown, ids: Map<string, string>, words: [string, string][]): unknown {
  if (typeof value === "string") {
    const mapped = ids.get(value)
    if (mapped) return mapped
    let text = value
    for (const [from, to] of words) if (from && text.includes(from)) text = text.replaceAll(from, to)
    return text
  }
  if (Array.isArray(value)) return value.map((item) => remap(item, ids, words))
  if (value && typeof value === "object" && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, ids, words)]))
  return value
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").toUpperCase()

/** One copy of a template: every record with new ids, a new reference, plate, VIN and customer reference. */
function copyOf(template: TemplateRows, n: number) {
  const suffix = `-s${String(n).padStart(3, "0")}`
  const reference = `CD-${FIRST_NUMBER + n - 1}`
  const ids = new Map(ownIds(template).map((id) => [id, `${id}${suffix}`]))
  const words: [string, string][] = [[template.order.reference, reference]]
  const customerRef = typeof template.order.details.customer_reference === "string" ? template.order.details.customer_reference : null
  if (customerRef) words.push([customerRef, `${customerRef.replace(/-\d+$/, "")}-S${String(n).padStart(3, "0")}`])
  const plates = new Map<string, { registration: string | null; vin: string | null }>()
  for (const vehicle of template.vehicles) {
    const code = hash(`${vehicle.id}${suffix}`)
    const registration = vehicle.registration ? `${vehicle.registration.replace(/[A-Z0-9]+$/, "")}${code.slice(0, 6)}` : null
    const vin = vehicle.syntheticVin ? `SYN${code.slice(6, 20)}` : null
    plates.set(vehicle.id, { registration, vin })
    if (vehicle.registration && registration) words.push([vehicle.registration, registration])
    if (vehicle.syntheticVin && vin) words.push([vehicle.syntheticVin, vin])
  }
  const copy = <T>(row: T) => remap(row, ids, words) as T
  const order = copy(template.order)
  order.reference = reference
  order.details = { ...order.details, synthetic_of: template.order.reference }
  return {
    reference,
    order,
    items: template.items.map(copy),
    vehicles: template.vehicles.map((vehicle) => ({ ...copy(vehicle), registration: plates.get(vehicle.id)?.registration ?? null, syntheticVin: plates.get(vehicle.id)?.vin ?? null })),
    addresses: template.addresses.map(copy),
    conversations: template.conversations.map(copy),
    messages: template.messages.map(copy),
    alerts: template.alerts.map(copy),
    events: template.events.map(copy),
    related: template.related.map(copy),
  }
}

async function insertAll<T extends Row>(rows: T[], insert: (batch: T[]) => Promise<unknown>, size = 400): Promise<void> {
  for (let start = 0; start < rows.length; start += size) await insert(rows.slice(start, start + size))
}

/** The dataset orders that may be copied, with the reason each other quiet order was left out. */
export async function scaleTemplates(): Promise<{ templates: CaseFile[]; skipped: { reference: string; why: string }[] }> {
  const files = (await getCases()).filter((file) => !file.order.synthetic)
  const from = await clockNow()
  const recordedUntil = (await demoStart()).getTime()
  // Records that belong to another order: a copy would point at that order (a bundle offer, a driver's earlier duty).
  const owner = new Map<string, string>()
  const related = await db.select({ id: relatedRecords.id, orderId: relatedRecords.orderId, details: relatedRecords.details }).from(relatedRecords)
  for (const row of related) if (row.orderId) owner.set(row.id, row.orderId)
  for (const table of [conversations, messages, alerts, operationalEvents, orderItems] as const) {
    for (const row of await db.select({ id: table.id, orderId: table.orderId }).from(table)) owner.set(row.id, row.orderId)
  }
  for (const row of await db.select({ id: orders.id }).from(orders)) owner.set(row.id, row.id)
  const foreign = new Set<string>()
  for (const row of related) {
    if (!row.orderId) continue
    for (const id of JSON.stringify(row.details).match(/"[a-z]+-[A-Za-z0-9-]+"/g) ?? []) {
      const other = owner.get(id.slice(1, -1))
      if (other && other !== row.orderId) foreign.add(row.orderId)
    }
  }
  // An order an agent has worked on is quiet only because of what the agent did (a driver's reply in a live chat).
  // A copy gets the dataset records, not that live work, so it would wake the Monitor: leave it out.
  const worked = new Set((await db.selectDistinct({ orderId: agentRuns.orderId }).from(agentRuns)
    .where(inArray(agentRuns.agent, ["Investigator", "Driver support", "Monitor"]))).map((row) => row.orderId))
  const templates: CaseFile[] = []
  const skipped: { reference: string; why: string }[] = []
  for (const file of files) {
    if (liveSignals(file).length || file.open.cards.length) continue
    const why = DEMO_ORDERS.has(file.order.reference) ? "a demo scenario or test plays with it"
      : worked.has(file.order.id) ? "an agent has worked on it; a copy would not carry that work"
      : foreign.has(file.order.id) ? "its records point at another order"
      : !staysQuiet(file, from, recordedUntil) ? "a Monitor rule or a disruption notice would notice it within 24 hours"
      : null
    if (why) skipped.push({ reference: file.order.reference, why })
    else templates.push(file)
  }
  return { templates, skipped }
}

/** Add synthetic copies until the database holds `total` orders. Builds their timelines, facts, search documents and quiet checks. */
export async function addScaleOrders(total = SCALE_TOTAL, log?: (line: string) => void): Promise<{ added: number; templates: number; skipped: { reference: string; why: string }[]; ms: number }> {
  const started = Date.now()
  const state = await scaleState()
  if (state.synthetic) await removeScaleOrders()
  const { templates, skipped } = await scaleTemplates()
  const count = Math.max(0, total - (state.total - state.synthetic))
  if (!templates.length || !count) return { added: 0, templates: templates.length, skipped, ms: Date.now() - started }
  log?.(`Copying ${templates.length} quiet orders into ${count} synthetic orders (${skipped.length} quiet orders left out).`)

  const ids = templates.map((file) => file.order.id)
  const [orderRows, itemRows, addressRows, threadRows, messageRows, alertRows, eventRows, relatedRows] = await Promise.all([
    db.select().from(orders).where(inArray(orders.id, ids)),
    db.select().from(orderItems).where(inArray(orderItems.orderId, ids)),
    db.select().from(addresses).where(inArray(addresses.orderId, ids)),
    db.select().from(conversations).where(inArray(conversations.orderId, ids)),
    db.select().from(messages).where(inArray(messages.orderId, ids)),
    db.select().from(alerts).where(inArray(alerts.orderId, ids)),
    db.select().from(operationalEvents).where(inArray(operationalEvents.orderId, ids)),
    db.select().from(relatedRecords).where(inArray(relatedRecords.orderId, ids)),
  ])
  const vehicleRows = itemRows.length ? await db.select().from(vehicles).where(inArray(vehicles.id, itemRows.map((row) => row.vehicleId))) : []
  const rowsOf = (orderId: string): TemplateRows => {
    const items = itemRows.filter((row) => row.orderId === orderId)
    return {
      order: orderRows.find((row) => row.id === orderId)!, items,
      vehicles: vehicleRows.filter((row) => items.some((item) => item.vehicleId === row.id)),
      addresses: addressRows.filter((row) => row.orderId === orderId), conversations: threadRows.filter((row) => row.orderId === orderId),
      messages: messageRows.filter((row) => row.orderId === orderId), alerts: alertRows.filter((row) => row.orderId === orderId),
      events: eventRows.filter((row) => row.orderId === orderId), related: relatedRows.filter((row) => row.orderId === orderId),
    }
  }
  const sources = new Map(ids.map((id) => [id, rowsOf(id)]))
  // Round-robin over the templates, so neighbouring references are different cars on different routes.
  const copies = Array.from({ length: count }, (_, index) => copyOf(sources.get(ids[index % ids.length])!, index + 1))
  const all = <K extends keyof (typeof copies)[number]>(key: K) => copies.flatMap((item) => item[key] as unknown as Row[])

  await db.transaction(async (tx) => {
    await insertAll(all("addresses") as (typeof addresses.$inferInsert)[], (batch) => tx.insert(addresses).values(batch))
    await insertAll(all("vehicles") as (typeof vehicles.$inferInsert)[], (batch) => tx.insert(vehicles).values(batch))
    await insertAll(copies.map((item) => item.order), (batch) => tx.insert(orders).values(batch))
    await insertAll(all("items") as (typeof orderItems.$inferInsert)[], (batch) => tx.insert(orderItems).values(batch))
    await insertAll(all("conversations") as (typeof conversations.$inferInsert)[], (batch) => tx.insert(conversations).values(batch))
    await insertAll(all("messages") as (typeof messages.$inferInsert)[], (batch) => tx.insert(messages).values(batch))
    await insertAll(all("alerts") as (typeof alerts.$inferInsert)[], (batch) => tx.insert(alerts).values(batch))
    await insertAll(all("events") as (typeof operationalEvents.$inferInsert)[], (batch) => tx.insert(operationalEvents).values(batch))
    await insertAll(all("related") as (typeof relatedRecords.$inferInsert)[], (batch) => tx.insert(relatedRecords).values(batch))
  })
  log?.(`Inserted ${copies.length} orders and their records in ${Date.now() - started} ms.`)

  // Their timelines, facts and search documents: the same code as npm run timeline:build, over the copies only.
  const copyIds = new Set(copies.map((item) => item.order.id))
  const [customerRows, driverRows, siteRows, allAddresses, shared] = await Promise.all([
    db.select().from(customers), db.select().from(drivers), db.select().from(sites), db.select().from(addresses),
    db.select().from(relatedRecords).where(isNull(relatedRecords.orderId)),
  ])
  const built = buildTimeline({
    orders: copies.map((item) => item.order), customers: customerRows, drivers: driverRows, sites: siteRows, addresses: allAddresses,
    vehicles: all("vehicles") as (typeof vehicles.$inferSelect)[], orderItems: all("items") as (typeof orderItems.$inferSelect)[],
    conversations: all("conversations") as (typeof conversations.$inferSelect)[], messages: all("messages") as (typeof messages.$inferSelect)[],
    alerts: all("alerts") as (typeof alerts.$inferSelect)[], events: all("events") as (typeof operationalEvents.$inferSelect)[],
    related: [...(all("related") as (typeof relatedRecords.$inferSelect)[]), ...shared],
  })
  const entries = built.entries.filter((entry) => entry.orderId && copyIds.has(entry.orderId))
  const factRows = built.facts.filter((fact) => copyIds.has(fact.orderId))
  const search = built.search.filter((doc) => copyIds.has(doc.orderId))
  await db.transaction(async (tx) => {
    await insertAll(entries.map((entry) => ({ ...entry, origin: "dataset" })), (batch) => tx.insert(timelineEntries).values(batch), 500)
    await insertAll(factRows.map((fact) => ({ ...fact, origin: "dataset" })), (batch) => tx.insert(facts).values(batch), 500)
    await insertAll(search, (batch) => tx.insert(searchDocuments).values(batch), 200)
  })
  log?.(`Built ${entries.length} timeline entries, ${factRows.length} facts and ${search.length} search documents.`)

  // A quiet check by code for each copy, as the backfill does for the dataset's quiet orders.
  const checked = await quietCheckAll([...copyIds])
  log?.(`Recorded ${checked} quiet checks.`)
  return { added: copies.length, templates: templates.length, skipped, ms: Date.now() - started }
}

/** Quiet checks for many orders at once (scale mode): the same rows quietCheck writes, in a few statements. */
export async function quietCheckAll(orderIds: string[]): Promise<number> {
  if (!orderIds.length) return 0
  const now = await clockNow()
  const files = (await getCases(orderIds)).filter((file) => !liveSignals(file).length)
  const runs = files.map((file) => {
    const outcome = quietOutcome(file, now)
    const id = `run_q${hash(`${file.order.id}|${now.toISOString()}`).slice(0, 9).toLowerCase()}`
    return {
      run: { id, orderId: file.order.id, agent: QUIET_AGENT, model: null, trigger: QUIET_TRIGGER, startedAt: now, finishedAt: now, status: "done", outcomeSummary: outcome.line, narration: outcome.line, nextCheckAt: outcome.nextCheckAt },
      step: { id: `${id}:0`, runId: id, idx: 0, at: now, type: "tool_result", tool: "quiet_check", input: outcome.input, output: outcome.output, summary: QUIET_STEP },
    }
  })
  await db.transaction(async (tx) => {
    await insertAll(runs.map((item) => item.run), (batch) => tx.insert(agentRuns).values(batch).onConflictDoNothing(), 500)
    await insertAll(runs.map((item) => item.step), (batch) => tx.insert(agentSteps).values(batch).onConflictDoNothing(), 500)
  })
  return runs.length
}

/** Remove every synthetic copy and everything written about it. The dataset's 100 orders are untouched. */
export async function removeScaleOrders(): Promise<{ removed: number; ms: number }> {
  const started = Date.now()
  const { synthetic } = await scaleState()
  if (!synthetic) return { removed: 0, ms: 0 }
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from agent_steps where run_id in (select id from agent_runs where order_id in ${SYNTHETIC})`)
    await tx.execute(sql`delete from agent_runs where order_id in ${SYNTHETIC}`)
    await tx.execute(sql`delete from decisions where card_id in (select id from cards where order_id in ${SYNTHETIC})`)
    for (const table of ["cards", "timeline_entries", "facts", "search_documents", "demo_events", "related_records", "operational_events", "alerts", "messages", "conversations", "order_items"]) {
      await tx.execute(sql`delete from ${sql.identifier(table)} where order_id in ${SYNTHETIC}`)
    }
    await tx.execute(sql`delete from orders where details ? 'synthetic_of'`)
    // Copies' vehicles and private addresses carry the copy suffix ("veh-00004-s012"); nothing else does.
    await tx.execute(sql`delete from vehicles where id ~ '-s[0-9]{3}$'`)
    await tx.execute(sql`delete from addresses where id ~ '-s[0-9]{3}$'`)
  })
  return { removed: synthetic, ms: Date.now() - started }
}
