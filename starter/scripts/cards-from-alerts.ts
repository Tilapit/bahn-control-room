// npm run cards:alerts [-- --reset]
// Writes the temporary phase-2 cards: one per order with an open or taken alert.
// Orders that already have an alert card (open or decided) are left alone unless --reset.

import "dotenv/config"
import { and, eq, inArray, like } from "drizzle-orm"
import { cardFromAlerts } from "@/lib/cards/from-alerts"
import { getCases } from "@/lib/case"
import { now } from "@/lib/clock"
import { closeDb, db } from "@/lib/db"
import { cards, decisions, timelineEntries } from "@/lib/schema"
import { urgency } from "@/lib/urgency"

async function main() {
  const reset = process.argv.includes("--reset")
  const at = await now()
  if (reset) {
    const old = await db.select({ id: cards.id }).from(cards).where(eq(cards.origin, "alert"))
    const ids = old.map((card) => card.id)
    if (ids.length) {
      await db.delete(decisions).where(inArray(decisions.cardId, ids))
      await db.delete(timelineEntries).where(and(eq(timelineEntries.origin, "live"), like(timelineEntries.id, "decision:%")))
      await db.delete(cards).where(inArray(cards.id, ids))
    }
  }
  const existing = new Set((await db.select({ orderId: cards.orderId }).from(cards).where(eq(cards.origin, "alert"))).map((row) => row.orderId))
  const files = await getCases()
  const fresh = files
    .filter((file) => !existing.has(file.order.id))
    .map((file) => cardFromAlerts(file, urgency(file, at)))
    .filter((card) => !!card)
  if (fresh.length) await db.insert(cards).values(fresh.map((card) => ({ ...card, createdAt: at, runId: null, verifierNotes: null })))
  console.log(`${fresh.length} temporary cards written${existing.size ? `, ${existing.size} orders already had one` : ""}.`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDb)
