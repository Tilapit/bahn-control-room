// npm run timeline:build
// Rebuilds the dataset part of the timeline, the code-derived facts and the
// search documents from the seeded tables. Idempotent: dataset rows are
// replaced, rows written live (ingest, agents, decisions) are kept.

import "dotenv/config"
import { eq, sql } from "drizzle-orm"
import { closeDb, db } from "@/lib/db"
import {
  addresses, alerts, conversations, customers, drivers, facts, messages, operationalEvents, orderItems, orders,
  relatedRecords, searchDocuments, sites, timelineEntries, vehicles,
} from "@/lib/schema"
import { buildTimeline } from "@/lib/timeline/build"

async function main() {
  const started = Date.now()
  const [orderRows, customerRows, driverRows, siteRows, addressRows, vehicleRows, itemRows, threadRows, messageRows, alertRows, eventRows, relatedRows] = await Promise.all([
    db.select().from(orders), db.select().from(customers), db.select().from(drivers), db.select().from(sites),
    db.select().from(addresses), db.select().from(vehicles), db.select().from(orderItems), db.select().from(conversations),
    db.select().from(messages), db.select().from(alerts), db.select().from(operationalEvents), db.select().from(relatedRecords),
  ])
  if (!orderRows.length) throw new Error("No orders in the database. Run `npm run db:seed` first.")

  const { entries, facts: factRows, search } = buildTimeline({
    orders: orderRows, customers: customerRows, drivers: driverRows, sites: siteRows, addresses: addressRows,
    vehicles: vehicleRows, orderItems: itemRows, conversations: threadRows, messages: messageRows, alerts: alertRows,
    events: eventRows, related: relatedRows,
  })

  await db.transaction(async (tx) => {
    await tx.delete(timelineEntries).where(eq(timelineEntries.origin, "dataset"))
    await tx.delete(facts).where(eq(facts.origin, "dataset"))
    await tx.execute(sql`TRUNCATE search_documents`)
    for (let i = 0; i < entries.length; i += 500) await tx.insert(timelineEntries).values(entries.slice(i, i + 500).map((entry) => ({ ...entry, origin: "dataset" })))
    for (let i = 0; i < factRows.length; i += 500) await tx.insert(facts).values(factRows.slice(i, i + 500).map((fact) => ({ ...fact, origin: "dataset" })))
    for (let i = 0; i < search.length; i += 200) await tx.insert(searchDocuments).values(search.slice(i, i + 200))
  })

  const bySource = new Map<string, number>()
  for (const entry of entries) bySource.set(entry.source, (bySource.get(entry.source) ?? 0) + 1)
  const unlinked = entries.filter((entry) => !entry.orderId).length
  console.log(`Timeline: ${entries.length} entries (${unlinked} not linked to an order), ${factRows.length} facts, ${search.length} search documents in ${Date.now() - started} ms.`)
  console.log([...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([source, count]) => `${source} ${count}`).join(" · "))
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDb)
