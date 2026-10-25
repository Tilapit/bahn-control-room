// npm run demo:reset
// Back to the recorded morning before a demo: every live decision, to-do, takeover and agent run made since is
// cleared, the recorded runs and the fictional colleagues' claims are loaded again, the demo clock goes back to the
// demo's start, and a playbook rule approved during a demo goes back to suggested.

import "dotenv/config"
import { eq } from "drizzle-orm"
import { resetToDemoStart } from "@/lib/clock"
import { closeDb, db } from "@/lib/db"
import { loadFixtures } from "@/lib/fixtures"
import { playbookRules } from "@/lib/schema"

async function main() {
  const counts = await loadFixtures()
  const clock = await resetToDemoStart()
  const rules = await db.update(playbookRules).set({ status: "suggested", evalPassed: null, evalResult: null, decidedAt: null })
    .where(eq(playbookRules.status, "approved")).returning({ id: playbookRules.id })
  console.log(`Recorded morning loaded (${counts.cards ?? 0} cards, ${counts.decisions ?? 0} decisions). Demo clock: ${clock.toISOString()}. Playbook rules reset: ${rules.length}.`)
  await closeDb()
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
