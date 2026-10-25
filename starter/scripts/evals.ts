// npm run evals [-- --recorded | --live] [case …]
// The eval cases in lib/evals.ts: the demo scenarios and the prompt-injection test, each a set of checks in code on
// what the agents did, plus the policy layer and every recorded card.
// Without an API key (or with --recorded) the checks read the recorded runs in fixtures/: no model, no database.
// With an API key (or --live) each case is played again with real models from the demo's start time, and the same
// checks read the rows the new run wrote. Live runs replace the recorded work on those orders and cost about $1.50;
// npm run fixtures:load brings the recorded morning back.

import "dotenv/config"
import { inArray, sql } from "drizzle-orm"
import { startInvestigation } from "@/lib/agents/investigator"
import { hasApiKey } from "@/lib/agents/llm"
import { resetOrderLiveState } from "@/lib/agents/reset"
import { getCase } from "@/lib/case"
import { resetToDemoStart } from "@/lib/clock"
import { closeDb, db } from "@/lib/db"
import { setAnswersOn, setAutoReply } from "@/lib/demo"
import { playDemoEvent } from "@/lib/demo-scenarios"
import { allRecorded, CASES, type Check, cardChecks, type EvalCase, liveRows, policyChecks, recordedRows, type Rows } from "@/lib/evals"
import { ingest, processEntry } from "@/lib/ingest"
import { runMonitor } from "@/lib/monitor"
import { agentRuns, evalCases } from "@/lib/schema"
import { liveSignals } from "@/lib/signals"

const ACTIVE = ["running", "waiting_driver", "waiting_site"]

/** Wait until the agents on these orders have settled: nothing working, and an Investigator has ended (or none started in 20 s). */
async function settled(orderIds: string[], started: number): Promise<void> {
  const until = Date.now() + 6 * 60_000
  while (Date.now() < until) {
    const runs = await db.select().from(agentRuns).where(inArray(agentRuns.orderId, orderIds))
    const busy = runs.some((run) => ACTIVE.includes(run.status))
    const ended = runs.some((run) => run.agent === "Investigator" && ["waiting_person", "done", "failed"].includes(run.status))
    if (!busy && (ended || Date.now() - started > 20_000)) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error("The agents did not settle within 6 minutes")
}

async function playLive(item: EvalCase): Promise<Rows> {
  const files = await Promise.all(item.orders.map((reference) => getCase(reference)))
  const ids = files.map((file, index) => { if (!file) throw new Error(`No order ${item.orders[index]}`); return file.order.id })
  const started = Date.now()
  await resetToDemoStart()
  await setAutoReply(true)
  for (const reference of item.orders) await setAnswersOn(reference, "always")
  const live = item.live
  if ("demoEvent" in live) {
    await playDemoEvent(live.demoEvent, "live")
    await settled(ids, started)
  } else {
    for (const id of ids) await resetOrderLiveState(id)
    const fresh = (await getCase(item.orders[0]))!
    if ("investigate" in live) await startInvestigation(item.orders[0], { trigger: `Open signals on this order: ${liveSignals(fresh).join("; ")}.`, autoReply: true })
    else if ("monitor" in live) await runMonitor({ startAgents: true, wait: true, only: [live.monitor] })
    else {
      const stored = await ingest({ order: item.orders[0], source: "driver_chat", channel: "driver_chat", authorType: "driver", authorLabel: fresh.order.driver?.name ?? "Driver", body: live.message, demoKind: "prompt injection test" })
      await processEntry(stored.entryId)
    }
    await settled(ids, started)
  }
  return liveRows(ids)
}

function print(title: string, checks: Check[]): void {
  const passed = checks.filter((item) => item.ok).length
  console.log(`\n${passed === checks.length ? "PASS" : "FAIL"}  ${title} (${passed} of ${checks.length})`)
  for (const item of checks) console.log(`  ${item.ok ? "✓" : "✗"} ${item.name}${item.ok ? "" : `\n      ${item.detail}`}`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--live") && !hasApiKey()) throw new Error("--live needs ANTHROPIC_API_KEY.")
  const live = args.includes("--live") || (!args.includes("--recorded") && hasApiKey())
  const only = args.filter((arg) => !arg.startsWith("--"))
  const cases = CASES.filter((item) => !only.length || only.includes(item.id))
  const database = await db.execute(sql`select 1`).then(() => true, () => false)
  if (live && !database) throw new Error("Live evals need the database (docker compose up -d --wait).")
  console.log(live
    ? `Live: ${cases.length} cases played again with real models, from the demo's start time. They replace the recorded work on their orders; npm run fixtures:load brings it back.`
    : `Recorded: ${cases.length} cases checked against the recorded runs in fixtures/ (no model, no API key${database ? "" : ", no database"}).`)

  let failed = 0
  const cardsSeen: { cards: Rows["cards"]; decisions: Rows["decisions"] } = { cards: [], decisions: [] }
  for (const item of cases) {
    const rows = live ? await playLive(item).catch((error) => { console.error(`  ${item.id}: ${error instanceof Error ? error.message : error}`); return null }) : recordedRows(item)
    if (!rows) { failed += 1; print(item.title, [{ name: "Ran", ok: false, detail: live ? "the live run failed" : "no recording" }]); continue }
    const checks = item.checks(rows)
    if (checks.some((entry) => !entry.ok)) failed += 1
    print(item.title, checks)
    cardsSeen.cards.push(...rows.cards.filter((card) => card.origin === "agent"))
    cardsSeen.decisions.push(...rows.decisions)
  }

  const policy = await policyChecks({ database })
  if (policy.some((entry) => !entry.ok)) failed += 1
  print(`Policy layer, as if an agent had been talked into it${database ? "" : " (the card-builder check needs the database; skipped)"}`, policy)

  // Every card: in recorded mode all 30 orders' cards, in live mode the cards these runs wrote.
  const scope = live ? cardsSeen : allRecorded()
  const cards = cardChecks(scope.cards, scope.decisions)
  if (cards.some((entry) => !entry.ok)) failed += 1
  print(live ? "Every card these live runs wrote" : "Every recorded agent card", cards)

  // Cases filed from people's corrections (Settings → Learning): listed with what the person wanted instead.
  if (database) {
    const corrections = await db.select().from(evalCases)
    const fromPeople = corrections.filter((row) => ["reject", "reply"].includes(String((row.humanCorrection as { choice?: string } | null)?.choice)))
    console.log(`\n${fromPeople.length} case${fromPeople.length === 1 ? "" : "s"} filed from people's corrections${fromPeople.length ? ":" : "."}`)
    for (const row of fromPeople) {
      const correction = row.humanCorrection as { choice?: string; reply?: string | null; rejected?: string | null }
      console.log(`  ${(row.agentProposal as { headline?: string } | null)?.headline ?? row.cardId}: ${correction.choice === "reply" ? `the person wrote “${correction.reply}”` : `rejected “${correction.rejected ?? "the proposal"}”${correction.reply ? `: “${correction.reply}”` : ""}`}`)
    }
  }

  const total = cases.length + 2
  console.log(`\n${failed ? `${failed} of ${total} groups failed.` : `All ${total} groups passed.`}`)
  if (failed) process.exitCode = 1
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(async () => {
  // Live agent work can still be writing its narration for a moment.
  await new Promise((resolve) => setTimeout(resolve, 500))
  await closeDb()
})
