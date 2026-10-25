// The Agents view (SPEC 8.2): every run, what it is doing in one sentence, when it
// looks again, and what it cost. Plus one run's steps in plain words for the trace page.

import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { now as clockNow } from "./clock"
import { db } from "./db"
import { MODELS, modelName } from "./models"
import { QUIET_AGENT } from "./quiet-check"
import { agentRuns, agentSteps, cards, orders, vehicles, orderItems } from "./schema"

export type RunFilter = "active" | "done" | "quiet"

export const RUN_STATUS: Record<string, string> = {
  running: "Working", waiting_driver: "Waiting for driver", waiting_site: "Waiting for site", waiting_person: "Waiting for you",
  done: "Done", failed: "Stopped",
}
const ACTIVE = ["running", "waiting_driver", "waiting_site", "waiting_person"]
const DESK_ZONE = "Europe/Helsinki"

export type RunRow = {
  id: string
  agent: string
  status: string
  statusLabel: string
  sentence: string
  reference: string | null
  car: string | null
  startedAt: string
  nextCheckAt: string | null
  /** "Sonnet → Opus", "Haiku", "Code". */
  model: string
  tokens: number
  costUsd: number
  replay: boolean
  /** A safety stop: its proposal is first on For you, so it is first here too. */
  safety: boolean
}

/** The main model of a run, and the move to the senior model when there was one. Haiku helpers (verifier, simulated driver, narrator) count in tokens and cost, not here. */
export function modelLine(run: typeof agentRuns.$inferSelect): string {
  if (!run.model) return "Code"
  const used = Object.keys(run.modelUsage ?? {})
  if (run.model === MODELS.opus && used.includes(MODELS.sonnet)) return "Sonnet → Opus"
  return modelName(run.model)
}

export function tokensOf(run: typeof agentRuns.$inferSelect): number {
  return run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens
}

/** "18k tokens", "1.4M tokens" */
export function tokenWords(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k tokens`
  return `${tokens} tokens`
}

export function dollars(usd: number): string {
  return usd >= 10 ? `$${usd.toFixed(1)}` : usd >= 0.01 ? `$${usd.toFixed(2)}` : usd > 0 ? "<$0.01" : "$0"
}

const dayKey = (date: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: DESK_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date)

export async function agentsView(filter: RunFilter) {
  const at = await clockNow()
  const [runs, orderRows, openCards] = await Promise.all([
    db.select().from(agentRuns).orderBy(desc(agentRuns.startedAt)),
    db.select({ id: orders.id, reference: orders.reference, make: vehicles.make, model: vehicles.model })
      .from(orders).leftJoin(orderItems, and(eq(orderItems.orderId, orders.id), eq(orderItems.role, "PRIMARY"))).leftJoin(vehicles, eq(vehicles.id, orderItems.vehicleId)),
    db.select({ runId: cards.runId, severity: cards.severity }).from(cards).where(eq(cards.status, "open")),
  ])
  const safetyRuns = new Set(openCards.filter((card) => card.severity === "safety").map((card) => card.runId))
  const byOrder = new Map(orderRows.map((row) => [row.id, row]))
  // A working run has no narration yet: show its latest step, so the row moves while it works.
  const working = runs.filter((run) => run.status === "running").map((run) => run.id)
  const latest = new Map<string, string>()
  if (working.length) {
    const steps = await db.select({ runId: agentSteps.runId, idx: agentSteps.idx, summary: agentSteps.summary, tool: agentSteps.tool })
      .from(agentSteps).where(and(inArray(agentSteps.runId, working), inArray(agentSteps.type, ["tool_result", "message"]))).orderBy(asc(agentSteps.idx))
    for (const step of steps) if (step.summary && !CARD_TOOLS.has(step.tool ?? "")) latest.set(step.runId, step.summary)
  }
  const quiet = (run: typeof runs[number]) => run.agent === QUIET_AGENT
  // A finished run that will look again is still the agents' work: it is what For you counts as "agents are handling".
  const watching = (run: typeof runs[number]) => !quiet(run) && run.status === "done" && !!run.nextCheckAt && run.nextCheckAt > at
  const active = (run: typeof runs[number]) => !quiet(run) && (ACTIVE.includes(run.status) || watching(run))
  const group = (run: typeof runs[number]) => watching(run) ? ACTIVE.length : ACTIVE.indexOf(run.status)
  const counts = { active: runs.filter(active).length, done: runs.filter((run) => !quiet(run) && !active(run)).length, quiet: runs.filter(quiet).length }
  const shown = runs
    .filter((run) => filter === "quiet" ? quiet(run) : filter === "active" ? active(run) : !quiet(run) && !active(run))
    // Working first, then waiting on someone, a safety stop before the rest; newest first inside each, then by order so equal times keep one order.
    .sort((a, b) => group(a) - group(b) || Number(safetyRuns.has(b.id)) - Number(safetyRuns.has(a.id))
      || b.startedAt.getTime() - a.startedAt.getTime() || (a.orderId ?? "").localeCompare(b.orderId ?? ""))
  const todayAll = runs.filter((run) => dayKey(run.startedAt) === dayKey(at))
  const today = todayAll.filter((run) => run.model)
  const rows: RunRow[] = shown.map((run) => {
    const order = run.orderId ? byOrder.get(run.orderId) : null
    return {
      // A finished run that looks again later is watching, not done; a quiet check only checked.
      id: run.id, agent: run.agent, status: run.status,
      statusLabel: quiet(run) ? "Checked" : watching(run) ? "Watching" : RUN_STATUS[run.status] ?? run.status,
      sentence: run.status === "running" ? `${latest.get(run.id) ?? "Reading the order's records"}…`
        : run.narration ?? (run.status === "waiting_person" && run.outcomeSummary ? `Wrote a proposal for a person: ${run.outcomeSummary.replace(/\.?$/, ".")}` : run.outcomeSummary ?? run.trigger),
      reference: order?.reference ?? null, car: order?.make ? `${order.make} ${order.model}` : null,
      startedAt: run.startedAt.toISOString(), nextCheckAt: run.nextCheckAt?.toISOString() ?? null,
      model: modelLine(run), tokens: tokensOf(run), costUsd: run.costUsd, replay: run.replay, safety: safetyRuns.has(run.id),
    }
  })
  return {
    now: at.toISOString(), rows, counts,
    today: {
      runs: today.length, codeRuns: todayAll.length - today.length, quietRuns: todayAll.filter(quiet).length,
      tokens: today.reduce((sum, run) => sum + tokensOf(run), 0), costUsd: today.reduce((sum, run) => sum + run.costUsd, 0),
    },
  }
}

// ---------------------------------------------------------------------------
// One run, in plain words
// ---------------------------------------------------------------------------

export type TraceStep = { idx: number; at: string; kind: "thought" | "action" | "reply" | "card"; text: string; details: unknown | null; error: boolean }

/** Step lines written before the wording change, in the words people read now: a draft is sent back, not a "card". */
function plainStep(text: string): string {
  return text
    .replace(/^Card sent back by code checks/, "Draft sent back by the code checks")
    .replace(/^Card sent back by the verifier/, "Draft sent back by the second check")
    .replace(/^Card held back: a finding or step in the same turn failed/, "Draft held back: one of its facts or actions was not accepted")
    .replace(/^Verifier found conflicting sources; handed to the senior model/, "The second check found records that disagree; handed to Opus, the larger model")
}

/** Card-building calls read as one action: "Drafted a proposal". */
const CARD_TOOLS = new Set(["add_finding", "add_step"])

export async function runTrace(runId: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  if (!run) return null
  const [steps, cardRows, order] = await Promise.all([
    db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(asc(agentSteps.idx)),
    db.select().from(cards).where(eq(cards.runId, runId)).orderBy(asc(cards.createdAt)),
    run.orderId ? db.select({ reference: orders.reference }).from(orders).where(eq(orders.id, run.orderId)).limit(1) : Promise.resolve([]),
  ])
  const calls = new Map(steps.filter((step) => step.type === "tool_call").map((step) => [step.idx, step]))
  const out: TraceStep[] = []
  let cardGroup: { findings: string[]; steps: string[]; problems: string[]; at: string; idx: number } | null = null
  const flushGroup = () => {
    if (!cardGroup) return
    const parts = [`${cardGroup.findings.length} fact${cardGroup.findings.length === 1 ? "" : "s"}`, cardGroup.steps.length ? `${cardGroup.steps.length} action${cardGroup.steps.length === 1 ? "" : "s"}` : null].filter(Boolean)
    out.push({
      idx: cardGroup.idx, at: cardGroup.at, kind: "action", error: cardGroup.problems.length > 0,
      text: `Drafted a proposal: ${parts.join(", ")}${cardGroup.problems.length ? `; the checks sent ${cardGroup.problems.length} back` : ""}.`,
      details: { findings: cardGroup.findings, actions: cardGroup.steps, notAccepted: cardGroup.problems },
    })
    cardGroup = null
  }
  for (const step of steps) {
    if (step.type === "tool_call") continue
    const output = step.output as { isError?: boolean; content?: string; text?: string } | null
    if (step.type === "tool_result" && CARD_TOOLS.has(step.tool ?? "")) {
      cardGroup ??= { findings: [], steps: [], problems: [], at: step.at.toISOString(), idx: step.idx }
      const text = (step.summary ?? "").replace(/^Noted a finding: /, "")
      if (output?.isError) cardGroup.problems.push(output.content ?? step.summary ?? "")
      else if (step.tool === "add_finding") cardGroup.findings.push(text)
      else cardGroup.steps.push(text)
      continue
    }
    flushGroup()
    if (step.type === "thought") {
      out.push({ idx: step.idx, at: step.at.toISOString(), kind: "thought", text: output?.text?.trim() ?? step.summary ?? "", details: null, error: false })
      continue
    }
    const call = step.tool ? [...calls.values()].filter((candidate) => candidate.idx < step.idx && candidate.tool === step.tool).pop() : undefined
    out.push({
      idx: step.idx, at: step.at.toISOString(), error: !!output?.isError,
      kind: step.type === "message" ? "reply" : step.tool === "propose" || step.tool === "resolve" ? "card" : "action",
      text: plainStep(step.summary ?? ""), details: { input: call?.input ?? step.input ?? null, output: step.output ?? null },
    })
  }
  flushGroup()
  return { run, reference: order[0]?.reference ?? null, steps: out, cards: cardRows, modelLine: modelLine(run), tokens: tokensOf(run) }
}

export async function runsForOrder(orderId: string) {
  return db.select().from(agentRuns).where(and(eq(agentRuns.orderId, orderId), inArray(agentRuns.agent, ["Investigator", "Driver support", "Classifier"]))).orderBy(desc(agentRuns.startedAt))
}
