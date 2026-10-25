import type { Metadata } from "next"
import { connection } from "next/server"
import { sql } from "drizzle-orm"
import { getCases } from "@/lib/case"
import { db } from "@/lib/db"
import { scaleState } from "@/lib/scale"
import { orders } from "@/lib/schema"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { hasApiKey } from "@/lib/agents/llm"
import { DEMO_EVENTS } from "@/lib/demo-scenarios"
import { RECORDING_DIR } from "@/lib/recording"
import { DemoControls } from "./demo-controls"
import { ScaleSwitch } from "./scale-switch"

export const metadata: Metadata = { title: "Demo controls" }

export default async function DemoPage() {
  await connection()
  // The driver phone is for the dataset's orders: scale mode's 900 copies would bury them in the list.
  const [realIds, scale] = await Promise.all([
    db.select({ id: orders.id }).from(orders).where(sql`not (${orders.details} ? 'synthetic_of')`).then((rows) => rows.map((row) => row.id)),
    scaleState(),
  ])
  const files = await getCases(realIds)
  const withDriver = files
    .filter((file) => file.order.driver && file.order.stage.key !== "delivered" && file.order.stage.key !== "cancelled")
    .map((file) => ({ reference: file.order.reference, label: `${file.order.reference} · ${file.order.car.label} · ${file.order.driver!.name}` }))
  return <main className="content narrow">
    <div className="page-head">
      <div>
        <h1>Demo controls</h1>
        <p className="page-sub">For the demo only. Everything here is simulated: the clock, the driver&apos;s phone and the scripted events.</p>
      </div>
    </div>
    <ScaleSwitch state={scale} />
    <DemoControls
      events={DEMO_EVENTS.map((event) => ({ ...event, recorded: existsSync(join(RECORDING_DIR, `${event.id}.json`)) }))}
      orders={withDriver} defaultOrder="CD-420322" live={hasApiKey()}
    />
  </main>
}
