// npm run agents:backfill [-- --concurrency 4] [--resume]
// The morning's work, done by the agents (SPEC 4, 7):
//   1. the Classifier reads every message already on an order, oldest first (one run per order);
//   2. the Investigator looks into every order with a live signal (4 at a time, the simulated
//      driver and sites answer its questions);
//   3. every other order gets a quiet check by code.
// Then everything is exported to fixtures/agent-runs.json, every agent run to traces/, and a
// report to fixtures/backfill-report.json. Starts from a clean slate, unless --resume: then only
// orders whose backfill run failed or never ran are done again (and the report covers all runs).

import "dotenv/config"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { and, asc, eq, inArray } from "drizzle-orm"
import { classifyEntry } from "@/lib/agents/classifier"
import { startInvestigation } from "@/lib/agents/investigator"
import { hasApiKey } from "@/lib/agents/llm"
import { resetAllLiveState, resetOrderLiveState } from "@/lib/agents/reset"
import { createRun, exportTrace, updateRun } from "@/lib/agents/runs"
import { getCase, getCases } from "@/lib/case"
import { now, resetClock, setDemoStart } from "@/lib/clock"
import { closeDb, db } from "@/lib/db"
import { scaleState } from "@/lib/scale"
import { exportFixtures } from "@/lib/fixtures"
import { MODELS, modelName, ROLE_MODEL } from "@/lib/models"
import { ensurePolicies } from "@/lib/policies"
import { runMonitor } from "@/lib/monitor"
import { quietCheck } from "@/lib/quiet-check"
import { agentRuns, agentSteps, cards, timelineEntries } from "@/lib/schema"
import { liveSignals } from "@/lib/signals"

function option(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name)
  return index >= 0 ? Number(args[index + 1]) || fallback : fallback
}

/** Run `work` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item)
  }))
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

async function classifyAll(concurrency: number, only: Set<string> | null) {
  const files = (await getCases()).filter((file) => !only || only.has(file.order.id))
  const messages = await db.select().from(timelineEntries).where(and(eq(timelineEntries.kind, "message"), eq(timelineEntries.origin, "dataset"))).orderBy(asc(timelineEntries.occurredAt))
  const byOrder = new Map<string, typeof messages>()
  for (const message of messages) if (message.orderId) byOrder.set(message.orderId, [...(byOrder.get(message.orderId) ?? []), message])
  const unlinked = messages.filter((message) => !message.orderId).length
  console.log(`Classifier: ${messages.length - unlinked} messages on ${byOrder.size} orders (${unlinked} unlinked support messages are left for a person)`)
  let read = 0
  await pool(files.filter((file) => byOrder.has(file.order.id)), concurrency, async (file) => {
    const list = byOrder.get(file.order.id)!
    const at = await now()
    const runId = await createRun({ orderId: file.order.id, agent: "Classifier", model: ROLE_MODEL.classifier, trigger: "Backfill: read the messages already on this order", at })
    let facts = 0
    for (const message of list) {
      try {
        const result = await classifyEntry(message.id, { runId })
        facts += result?.factIds.length ?? 0
      } catch (cause) {
        console.error(`  ${file.order.reference} ${message.id}: ${cause instanceof Error ? cause.message : cause}`)
      }
    }
    const summary = `Read ${list.length} message${list.length === 1 ? "" : "s"} on this order; filed ${facts} fact${facts === 1 ? "" : "s"} and agreement${facts === 1 ? "" : "s"}, each marked as stated, not confirmed.`
    await updateRun(runId, { status: "done", finishedAt: await now(), outcomeSummary: summary, narration: summary })
    await exportTrace(runId)
    read += list.length
    process.stdout.write(`  ${file.order.reference}: ${list.length} messages, ${facts} facts (${read} read)\n`)
  })
}

async function main() {
  // The backfill is the recorded morning of the 100 dataset orders. With scale mode on it would send 900 copies to the models.
  if ((await scaleState()).synthetic) throw new Error("Scale mode is on. Turn it off first: npm run seed:scale -- --off")
  const args = process.argv.slice(2)
  // --report-only: no agents; write the report and the fixtures from what the database holds.
  const reportOnly = args.includes("--report-only")
  if (!reportOnly && !hasApiKey()) throw new Error("The backfill runs real agents: set ANTHROPIC_API_KEY in starter/.env. Without a key, npm run fixtures:load shows the recorded runs.")
  const concurrency = option(args, "--concurrency", 4)
  const resume = args.includes("--resume")
  await ensurePolicies()
  const wallStart = Date.now()
  let files = await getCases()
  let todo: typeof files = []
  if (reportOnly) {
    console.log("Report only: no agents run.")
  } else if (resume) {
    // Done: a backfill Investigator run that ended with a card or closed the case. Everything else on a
    // live-signal order (a failed run, a run stuck waiting, no run) is forgotten and done again.
    const ok = new Set((await db.select().from(agentRuns).where(and(eq(agentRuns.agent, "Investigator"), inArray(agentRuns.status, ["done", "waiting_person"]))))
      .filter((run) => run.trigger.startsWith("Backfill")).map((run) => run.orderId))
    const tried = new Set((await db.select().from(agentRuns).where(eq(agentRuns.agent, "Investigator"))).map((run) => run.orderId))
    todo = files.filter((file) => !ok.has(file.order.id) && (tried.has(file.order.id) || liveSignals(file).length))
    for (const file of todo) await resetOrderLiveState(file.order.id, { allFacts: true })
    // The quiet checks are done again at the end; their steps go with them.
    await db.delete(agentSteps).where(inArray(agentSteps.runId, db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.agent, "Quiet check"))))
    await db.delete(agentRuns).where(eq(agentRuns.agent, "Quiet check"))
    console.log(`Resuming: ${todo.length} orders to do again (${todo.map((file) => file.order.reference).join(", ") || "none"}); ${ok.size} are done.`)
    files = await getCases()
    todo = files.filter((file) => todo.some((item) => item.order.id === file.order.id))
  } else {
    await resetAllLiveState()
    await resetClock()
    console.log("Cleared earlier live work (runs, agent cards, decisions, live entries, facts from messages).")
    todo = files
  }

  if (!reportOnly) await classifyAll(8, resume ? new Set(todo.map((file) => file.order.id)) : null)

  files = await getCases()
  const todoIds = new Set(todo.map((file) => file.order.id))
  const investigated = new Set((await db.select({ orderId: agentRuns.orderId }).from(agentRuns).where(eq(agentRuns.agent, "Investigator"))).map((run) => run.orderId))
  const live = files.filter((file) => todoIds.has(file.order.id) && liveSignals(file).length)
  const quiet = files.filter((file) => !liveSignals(file).length && !investigated.has(file.order.id))
  console.log(`\nInvestigator: ${live.length} orders with a live signal, ${concurrency} at a time`)
  const results: { reference: string; runId: string; status: string; wallMs: number; error?: string }[] = []
  await pool(live, concurrency, async (file) => {
    const reference = file.order.reference
    const fresh = (await getCase(reference))!
    const started = Date.now()
    try {
      const outcome = await startInvestigation(reference, { trigger: `Backfill. Open signals on this order: ${liveSignals(fresh).join("; ")}.`, autoReply: true })
      results.push({ reference, runId: outcome.runId, status: outcome.status, wallMs: Date.now() - started })
      console.log(`  ${reference}: ${outcome.status} in ${Math.round((Date.now() - started) / 1000)} s — ${outcome.summary}`)
    } catch (cause) {
      results.push({ reference, runId: "", status: "error", wallMs: Date.now() - started, error: cause instanceof Error ? cause.message : String(cause) })
      console.error(`  ${reference}: ERROR ${cause instanceof Error ? cause.message : cause}`)
    }
  })

  if (!reportOnly) {
    // The Monitor's rules run on the whole morning: a notice in the feed can touch an order nobody has reported on.
    console.log("\nMonitor rules")
    await runMonitor({ startAgents: true, wait: true, log: (line) => console.log(`  ${line}`) })
    // An order the Monitor handed to the Investigator is not quiet any more.
    const handed = new Set((await db.select({ orderId: agentRuns.orderId }).from(agentRuns).where(eq(agentRuns.agent, "Investigator"))).map((run) => run.orderId))
    const stillQuiet = quiet.filter((file) => !handed.has(file.order.id))
    console.log(`\nQuiet checks: ${stillQuiet.length} orders, by code`)
    const at = await now()
    for (const file of stillQuiet) await quietCheck(file, at)
  }

  // Report.
  const runs = await db.select().from(agentRuns)
  const backfillRuns = runs.filter((run) => run.agent === "Investigator" && run.trigger.startsWith("Backfill"))
  const ids = new Set(backfillRuns.map((run) => run.id))
  const byModel = (model: string) => runs.filter((run) => (run.modelUsage ?? {})[model]?.calls)
  const modelSummary = Object.values(MODELS).map((model) => {
    const using = byModel(model)
    const cost = runs.reduce((sum, run) => sum + ((run.modelUsage ?? {})[model]?.costUsd ?? 0), 0)
    const calls = runs.reduce((sum, run) => sum + ((run.modelUsage ?? {})[model]?.calls ?? 0), 0)
    const agents = [...new Set(using.map((run) => run.agent))]
    return { model: modelName(model), runs: using.length, calls, costUsd: cost, agents }
  })
  const finalModel = (model: string) => backfillRuns.filter((run) => run.model === model)
  const escalations = backfillRuns.filter((run) => run.escalation).map((run) => ({ runId: run.id, reason: run.escalation }))
  const cardRows = await db.select().from(cards).where(and(eq(cards.origin, "agent"), inArray(cards.runId, [...ids].filter(Boolean))))
  const walls = backfillRuns.map((run) => run.wallMs)
  const totalCost = runs.reduce((sum, run) => sum + run.costUsd, 0)
  const agentCost = (agent: string) => runs.filter((run) => run.agent === agent).reduce((sum, run) => sum + run.costUsd, 0)
  const report = {
    finishedAt: new Date().toISOString(), wallClockMinutes: reportOnly ? null : Math.round((Date.now() - wallStart) / 600) / 100, simulatedClockAfter: (await now()).toISOString(),
    orders: {
      total: files.length,
      investigated: new Set(backfillRuns.map((run) => run.orderId)).size,
      liveSignalNoRunYet: files.filter((file) => liveSignals(file).length && !backfillRuns.some((run) => run.orderId === file.order.id)).map((file) => file.order.reference),
      quietChecks: runs.filter((run) => run.agent === "Quiet check").length,
    },
    investigator: {
      runs: backfillRuns.length, cards: cardRows.length, closedWithoutCard: backfillRuns.filter((run) => run.status === "done").length,
      failed: backfillRuns.filter((run) => !["done", "waiting_person"].includes(run.status)).map((run) => ({ runId: run.id, status: run.status, summary: run.outcomeSummary })),
      endedOnSonnet: finalModel(MODELS.sonnet).length, endedOnOpus: finalModel(MODELS.opus).length,
      startedOnOpusForSafety: backfillRuns.filter((run) => run.escalation?.startsWith("Safety case")).length,
      escalations,
      costUsd: { total: agentCost("Investigator"), average: agentCost("Investigator") / Math.max(1, backfillRuns.length) },
      wallSeconds: { median: Math.round(median(walls) / 100) / 10, max: Math.round(Math.max(0, ...walls) / 100) / 10, perRun: backfillRuns.map((run) => ({ runId: run.id, seconds: Math.round(run.wallMs / 100) / 10 })) },
    },
    classifier: { runs: runs.filter((run) => run.agent === "Classifier").length, costUsd: agentCost("Classifier") },
    quietChecks: runs.filter((run) => run.agent === "Quiet check").length,
    models: modelSummary,
    costUsd: { total: totalCost, averagePerAgentRun: totalCost / Math.max(1, runs.filter((run) => run.model).length) },
  }
  for (const result of results) if (result.runId) await exportTrace(result.runId)
  if (!reportOnly) await setDemoStart(await now())
  const counts = await exportFixtures()
  await writeFile(join(process.cwd(), "..", "fixtures", "backfill-report.json"), `${JSON.stringify(report, null, 2)}\n`)

  console.log(`\nDone in ${report.wallClockMinutes} min. Simulated clock is now ${report.simulatedClockAfter}.`)
  console.log(`Investigator: ${report.investigator.runs} runs, ${report.investigator.cards} cards, ${report.investigator.closedWithoutCard} closed without a card, ${report.investigator.failed.length} failed`)
  console.log(`  ended on Sonnet ${report.investigator.endedOnSonnet}, on Opus ${report.investigator.endedOnOpus} (${report.investigator.startedOnOpusForSafety} safety from the start)`)
  for (const escalation of escalations) console.log(`  ${escalation.runId}: ${escalation.reason}`)
  console.log(`  cost $${report.investigator.costUsd.total.toFixed(2)} total, $${report.investigator.costUsd.average.toFixed(3)} average; wall clock median ${report.investigator.wallSeconds.median} s, max ${report.investigator.wallSeconds.max} s`)
  for (const model of modelSummary) console.log(`${model.model}: ${model.runs} runs, ${model.calls} calls, $${model.costUsd.toFixed(3)} (${model.agents.join(", ")})`)
  console.log(`All runs: $${totalCost.toFixed(2)}`)
  console.log(`Fixtures: ${Object.entries(counts).map(([table, n]) => `${table} ${n}`).join(", ")}`)
  const failedRun = results.find((result) => result.status === "error")
  if (failedRun) process.exitCode = 1
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDb)
