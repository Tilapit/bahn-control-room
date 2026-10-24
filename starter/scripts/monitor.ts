// npm run monitor [-- --dry]
// Runs the Monitor's rules once against the simulated clock and prints what they found. Without --dry (and with an
// API key) it starts the Investigator for each hit and waits for it. --dry records nothing and starts nothing.

import "dotenv/config"
import { getCases } from "@/lib/case"
import { now } from "@/lib/clock"
import { closeDb } from "@/lib/db"
import { activeDisruptions, matchDisruption } from "@/lib/disruptions"
import { runMonitor } from "@/lib/monitor"

async function main() {
  if (process.argv.includes("--dry")) {
    const at = await now()
    const files = await getCases()
    for (const notice of await activeDisruptions(at)) {
      const matches = matchDisruption(notice, files, at)
      console.log(`${notice.title} (${notice.sourceLabel}): ${matches.length ? matches.map((match) => `${match.file.order.reference}: ${match.effect}`).join("\n  ") : "no order affected"}`)
    }
    return
  }
  const hits = await runMonitor({ startAgents: true, wait: true, log: console.log })
  console.log(hits.length ? `${hits.length} monitor hit${hits.length === 1 ? "" : "s"}.` : "Nothing new for the Monitor.")
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDb)
