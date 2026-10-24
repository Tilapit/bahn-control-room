// Agent runs and their steps: what each agent did, in order, with the full tool
// input and output, the tokens it used and what it cost. Every run is also
// written as a trace file to traces/<order-ref>-<run-id>.json (SPEC 7).

import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { asc, eq, sql } from "drizzle-orm"
import { db } from "../db"
import { addUsage, costUsd, type Usage } from "../models"
import { agentRuns, agentSteps, cards, decisions, orders } from "../schema"

export type StepType = "thought" | "tool_call" | "tool_result" | "message"

export async function createRun(input: { orderId: string | null; agent: string; model: string | null; trigger: string; at: Date }): Promise<string> {
  const id = `run_${randomUUID().slice(0, 8)}`
  await db.insert(agentRuns).values({ id, orderId: input.orderId, agent: input.agent, model: input.model, trigger: input.trigger, startedAt: input.at, status: "running" })
  return id
}

export async function nextStepIndex(runId: string): Promise<number> {
  const steps = await db.select({ idx: agentSteps.idx }).from(agentSteps).where(eq(agentSteps.runId, runId))
  return steps.reduce((max, step) => Math.max(max, step.idx + 1), 0)
}

export async function addStep(runId: string, idx: number, step: { at: Date; type: StepType; tool?: string | null; input?: unknown; output?: unknown; summary: string }): Promise<string> {
  const id = `${runId}:${idx}`
  await db.insert(agentSteps).values({
    id, runId, idx, at: step.at, type: step.type, tool: step.tool ?? null,
    input: step.input === undefined ? null : step.input, output: step.output === undefined ? null : step.output, summary: step.summary,
  })
  return id
}

/** Add one model call's tokens and cost to the run, in total and for the model that answered. */
export async function addUsageToRun(runId: string, model: string, usage: Usage): Promise<void> {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  if (!run) return
  const total = addUsage({ input: run.inputTokens, output: run.outputTokens, cacheRead: run.cacheReadTokens, cacheWrite: run.cacheWriteTokens }, usage)
  const cost = costUsd(model, usage)
  const byModel = { ...(run.modelUsage ?? {}) }
  const before = byModel[model] ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
  byModel[model] = { ...addUsage(before, usage), calls: before.calls + 1, costUsd: before.costUsd + cost }
  await db.update(agentRuns).set({
    inputTokens: total.input, outputTokens: total.output, cacheReadTokens: total.cacheRead, cacheWriteTokens: total.cacheWrite,
    costUsd: run.costUsd + cost, modelUsage: byModel,
  }).where(eq(agentRuns.id, runId))
}

/** Add real working time (milliseconds) to the run. */
export async function addWallTime(runId: string, ms: number): Promise<void> {
  await db.update(agentRuns).set({ wallMs: sql`${agentRuns.wallMs} + ${Math.max(0, Math.round(ms))}` }).where(eq(agentRuns.id, runId))
}

export async function updateRun(runId: string, patch: Partial<typeof agentRuns.$inferInsert>): Promise<void> {
  await db.update(agentRuns).set(patch).where(eq(agentRuns.id, runId))
}

export async function getRun(runId: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  return run ?? null
}

/** The run, its steps, and the card and decisions it led to, as one JSON file. */
export async function exportTrace(runId: string): Promise<string | null> {
  const run = await getRun(runId)
  if (!run) return null
  const [steps, cardRows, order] = await Promise.all([
    db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(asc(agentSteps.idx)),
    db.select().from(cards).where(eq(cards.runId, runId)),
    run.orderId ? db.select({ reference: orders.reference }).from(orders).where(eq(orders.id, run.orderId)).limit(1) : Promise.resolve([]),
  ])
  const decisionRows = cardRows.length ? (await Promise.all(cardRows.map((card) => db.select().from(decisions).where(eq(decisions.cardId, card.id))))).flat() : []
  const reference = order[0]?.reference ?? "no-order"
  const { state: _state, ...runFields } = run
  const trace = {
    run: { ...runFields, reference },
    steps: steps.map(({ runId: _runId, ...step }) => step),
    cards: cardRows,
    decisions: decisionRows,
  }
  const dir = join(process.cwd(), "..", "traces")
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${reference}-${runId}.json`)
  await writeFile(file, `${JSON.stringify(trace, null, 2)}\n`)
  return file
}
