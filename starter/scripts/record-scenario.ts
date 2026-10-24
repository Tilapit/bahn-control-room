// npm run scenario:record -- scenario-2 [more ids]
// Plays a demo event live (real agents, simulated driver) and records every row it writes with the
// real time it appeared, to fixtures/recordings/<id>.json. The Demo page can then replay it at the
// same speed, also without an API key. Restores nothing: run npm run fixtures:load afterwards.

import "dotenv/config"
import { and, eq, inArray } from "drizzle-orm"
import { getCase } from "@/lib/case"
import { resetToDemoStart } from "@/lib/clock"
import { closeDb, db } from "@/lib/db"
import { DEMO_EVENTS, playDemoEvent } from "@/lib/demo-scenarios"
import { recordScenario } from "@/lib/recording"
import { agentRuns } from "@/lib/schema"

const ACTIVE = ["running", "waiting_driver", "waiting_site"]

async function main() {
  const ids = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
  if (!ids.length) throw new Error(`Usage: npm run scenario:record -- ${DEMO_EVENTS.map((event) => event.id).join(" | ")}`)
  for (const id of ids) {
    const event = DEMO_EVENTS.find((candidate) => candidate.id === id)
    if (!event) throw new Error(`No demo event ${id}`)
    // Every recording starts where the demo starts, so a replay lines up with the recorded morning.
    await resetToDemoStart()
    const file = (await getCase(event.order))!
    const orderIds = [file.order.id, ...(await Promise.all((event.others ?? []).map((reference) => getCase(reference)))).map((item) => item!.order.id)]
    let started = 0
    const recording = await recordScenario({
      scenario: id, order: event.order, orderId: file.order.id, orderIds, log: console.log,
      start: async () => { started = Date.now(); await playDemoEvent(id, "live") },
      // Settled: nothing is working or waiting on the driver, and an Investigator ended (or 20 s passed without one).
      done: async () => {
        // The scenario reset the order first, so every run on it belongs to this play.
        const runs = await db.select().from(agentRuns).where(inArray(agentRuns.orderId, orderIds))
        if (runs.some((run) => ACTIVE.includes(run.status))) return false
        const investigated = runs.some((run) => run.agent === "Investigator" && ["waiting_person", "done", "failed"].includes(run.status))
        return investigated || Date.now() - started > 20_000
      },
    })
    const investigator = (await db.select().from(agentRuns).where(and(eq(agentRuns.orderId, file.order.id), inArray(agentRuns.agent, ["Investigator"]))))
    console.log(`${id}: ${recording.events.length} changes, ${Math.round(recording.durationMs / 1000)} s from the first event to the last${investigator.length ? `; Investigator worked ${investigator.map((run) => `${Math.round(run.wallMs / 1000)} s (${run.status})`).join(", ")}` : ""}`)
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(async () => {
  // Agent work runs in the background of playDemoEvent; give the last writes a moment.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await closeDb()
})
