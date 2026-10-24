// npm run fixtures:load    replace live work with the recorded agent runs (fixtures/agent-runs.json)
// npm run fixtures:export  write the current live work to that file
// The backfill exports by itself; a fresh clone loads the file in `npm run setup`.

import "dotenv/config"
import { closeDb } from "@/lib/db"
import { exportFixtures, FIXTURE_FILE, loadFixtures } from "@/lib/fixtures"

async function main() {
  const command = process.argv[2]
  if (command === "export") {
    const counts = await exportFixtures()
    console.log(`Exported to ${FIXTURE_FILE}: ${Object.entries(counts).map(([table, n]) => `${table} ${n}`).join(", ")}`)
  } else if (command === "load") {
    const counts = await loadFixtures()
    console.log(`Loaded recorded agent runs: ${Object.entries(counts).map(([table, n]) => `${table} ${n}`).join(", ")}`)
  } else throw new Error("Usage: tsx scripts/fixtures.ts load | export")
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDb)
