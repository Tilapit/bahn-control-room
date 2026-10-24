// npm run urgency
// Prints every order with a live signal in queue order, with its consequence sentence.

import "dotenv/config"
import { getCases } from "@/lib/case"
import { now } from "@/lib/clock"
import { closeDb } from "@/lib/db"
import { liveSignals } from "@/lib/signals"
import { compareUrgency, urgency } from "@/lib/urgency"

async function main() {
  const at = await now()
  const files = await getCases()
  const live = files
    .map((file) => ({ file, reasons: liveSignals(file), urgency: urgency(file, at) }))
    .filter((row) => row.reasons.length)
    .sort((a, b) => compareUrgency(a.urgency, b.urgency))
  console.log(`${live.length} of ${files.length} orders have a live signal. Clock: ${at.toISOString()}\n`)
  for (const { file, urgency: u, reasons } of live) {
    const mark = u.safety ? "SAFETY" : u.timeRisk ? "time  " : "      "
    console.log(`${mark} ${file.order.reference}  ${u.sentence}${u.relative ? `  [${u.relative}]` : ""}`)
    console.log(`         ${file.order.car.label} · ${file.order.stage.label} · ${reasons.slice(0, 3).join("; ")}`)
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDb)
