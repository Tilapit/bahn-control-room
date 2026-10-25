// npm run quiet:lines
// Rewrites the sentence of every recorded quiet check with today's wording
// (lib/quiet-check.ts), at the time the check ran. Quiet checks are code only,
// so the new sentence is exactly what the check would have written. Run after a
// wording change, then `npm run fixtures:export` to keep the recording in step.

import "dotenv/config"
import { eq } from "drizzle-orm"
import { getCase } from "@/lib/case"
import { closeDb, db } from "@/lib/db"
import { QUIET_AGENT, quietLine } from "@/lib/quiet-check"
import { agentRuns } from "@/lib/schema"

async function main() {
  const runs = await db.select().from(agentRuns).where(eq(agentRuns.agent, QUIET_AGENT))
  let changed = 0
  for (const run of runs) {
    const file = run.orderId ? await getCase(run.orderId) : null
    if (!file) continue
    const line = quietLine(file, run.startedAt)
    if (line === run.narration) continue
    await db.update(agentRuns).set({ narration: line, outcomeSummary: line }).where(eq(agentRuns.id, run.id))
    changed += 1
  }
  console.log(`Quiet checks: ${changed} of ${runs.length} sentences rewritten.`)
}

main().finally(closeDb)
