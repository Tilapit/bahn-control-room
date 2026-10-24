// npm run agents:narrate -- <run id> … | --all
// Writes the Narrator's sentence again for runs (all Investigator and Driver support runs with --all).

import "dotenv/config"
import { inArray } from "drizzle-orm"
import { narrateRun } from "@/lib/agents/narrator"
import { closeDb, db } from "@/lib/db"
import { agentRuns } from "@/lib/schema"

async function main() {
  const args = process.argv.slice(2)
  const ids = args.includes("--all")
    ? (await db.select({ id: agentRuns.id }).from(agentRuns).where(inArray(agentRuns.agent, ["Investigator", "Driver support"]))).map((run) => run.id)
    : args.filter((arg) => !arg.startsWith("--"))
  const queue = [...ids]
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) console.log(`${id}: ${await narrateRun(id) ?? "(kept the code's summary)"}`)
  }))
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDb)
