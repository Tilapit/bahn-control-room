import type { Metadata } from "next"
import { connection } from "next/server"
import { getCases } from "@/lib/case"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { hasApiKey } from "@/lib/agents/llm"
import { DEMO_EVENTS } from "@/lib/demo-scenarios"
import { RECORDING_DIR } from "@/lib/recording"
import { DemoControls } from "./demo-controls"

export const metadata: Metadata = { title: "Demo controls" }

export default async function DemoPage() {
  await connection()
  const files = await getCases()
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
    <DemoControls
      events={DEMO_EVENTS.map((event) => ({ ...event, recorded: existsSync(join(RECORDING_DIR, `${event.id}.json`)) }))}
      orders={withDriver} defaultOrder="CD-420322" live={hasApiKey()}
    />
  </main>
}
