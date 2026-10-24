// npm run agents:trace -- <run-id | CD-reference>
// Prints one agent run as a readable trace: every step in order, with tokens and cost.
// The full JSON (tool inputs and outputs) is in traces/<order-ref>-<run-id>.json.

import "dotenv/config"
import { and, asc, desc, eq } from "drizzle-orm"
import { closeDb, db } from "@/lib/db"
import { exportTrace } from "@/lib/agents/runs"
import { modelName } from "@/lib/models"
import { agentRuns, agentSteps, orders } from "@/lib/schema"

async function main() {
  const arg = process.argv[2]
  if (!arg) throw new Error("Usage: npm run agents:trace -- <run-id | CD-reference>")
  const [run] = arg.startsWith("run_")
    ? await db.select().from(agentRuns).where(eq(agentRuns.id, arg))
    : await db.select({ run: agentRuns }).from(agentRuns).innerJoin(orders, eq(orders.id, agentRuns.orderId))
      .where(and(eq(orders.reference, arg.toUpperCase()), eq(agentRuns.agent, "Investigator"))).orderBy(desc(agentRuns.startedAt)).limit(1).then((rows) => rows.map((row) => row.run))
  if (!run) throw new Error(`No run ${arg}`)
  const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, run.id)).orderBy(asc(agentSteps.idx))
  const file = await exportTrace(run.id)
  console.log(`${run.agent} · ${run.id} · ${modelName(run.model)}${run.escalation ? ` (${run.escalation})` : ""} · ${run.status}`)
  console.log(`Trigger: ${run.trigger}`)
  console.log(`Tokens: ${run.inputTokens} in, ${run.outputTokens} out, ${run.cacheReadTokens} read from cache, ${run.cacheWriteTokens} written to cache · $${run.costUsd.toFixed(4)}\n`)
  for (const step of steps) {
    if (step.type === "tool_call") continue
    const mark = step.type === "thought" ? "think" : step.type === "message" ? "  >>>" : `${(step.tool ?? "").padEnd(5).slice(0, 5)}`
    console.log(`${String(step.idx).padStart(3)} ${mark}  ${(step.summary ?? "").replace(/\s+/g, " ")}`)
  }
  console.log(`\nOutcome: ${run.outcomeSummary}\nFull trace: ${file}`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDb)
