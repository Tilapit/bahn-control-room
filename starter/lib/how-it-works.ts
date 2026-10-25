// The measured numbers on the How it works page. They come from the recorded morning (fixtures/agent-runs.json):
// the backfill's runs as they were recorded, so playing a scenario on the Demo page does not change them.

import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { MODELS } from "./models"

type Row = Record<string, unknown>

export type Morning = {
  /** When the recorded morning was exported (real time), and the simulated hours the backfill covered. */
  exportedAt: string
  simulatedFrom: string
  simulatedTo: string
  /** Real minutes the whole backfill took, from its report. */
  wallMinutes: number | null
  orders: { total: number; investigated: number; quietChecks: number }
  investigator: {
    runs: number; cards: number; closed: number
    sonnet: number; opus: number; safety: number; conflict: number; overCost: number
    totalUsd: number; averageUsd: number
    medianSeconds: number; maxSeconds: number; closeSeconds: [number, number]
    /** The order of the longest run, for the page to name it. */
    longestOrderId: string | null
  }
  classifier: { runs: number; messages: number; usd: number }
  /** Every model call that morning: Investigator, Classifier, and the Haiku helpers (Verifier, simulated driver, Narrator). */
  all: { runs: number; usd: number; haikuUsd: number; sonnetUsd: number; opusUsd: number }
}

const ROOT = join(process.cwd(), "..")
let cached: { mtime: number; value: Morning | null } | null = null

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length ? sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 : 0
}

/** The recorded morning's numbers, or null when there is no recording. */
export function recordedMorning(): Morning | null {
  const file = join(ROOT, "fixtures", "agent-runs.json")
  let mtime = 0
  try { mtime = statSync(file).mtimeMs } catch { return null }
  if (cached?.mtime === mtime) return cached.value
  const fixture = JSON.parse(readFileSync(file, "utf8")) as { exportedAt: string; tables: Record<string, Row[]> }
  const runs = fixture.tables.agent_runs ?? []
  const steps = fixture.tables.agent_steps ?? []
  const cards = fixture.tables.cards ?? []
  // The backfill's own runs: one per order with a live signal (not the Monitor's, not the tests run later).
  const backfill = runs.filter((run) => run.agent === "Investigator" && String(run.trigger).startsWith("Backfill"))
  const classifier = runs.filter((run) => run.agent === "Classifier" && String(run.trigger).startsWith("Backfill"))
  const classifierIds = new Set(classifier.map((run) => run.id))
  const ids = new Set(backfill.map((run) => run.id))
  const cost = (list: Row[]) => list.reduce((sum, run) => sum + Number(run.cost_usd ?? 0), 0)
  const byModel = (model: string) => runs.reduce((sum, run) => sum + Number((run.model_usage as Record<string, { costUsd: number }> | null)?.[model]?.costUsd ?? 0), 0)
  const seconds = backfill.map((run) => Number(run.wall_ms ?? 0) / 1000)
  const closed = backfill.filter((run) => run.status === "done")
  const reason = (prefix: string) => backfill.filter((run) => String(run.escalation ?? "").startsWith(prefix)).length
  let wallMinutes: number | null = null
  try { wallMinutes = (JSON.parse(readFileSync(join(ROOT, "fixtures", "backfill-report.json"), "utf8")) as { wallClockMinutes?: number | null }).wallClockMinutes ?? null } catch { /* no report */ }
  const times = backfill.flatMap((run) => [String(run.started_at), String(run.finished_at ?? run.started_at)]).sort()
  const value: Morning = {
    exportedAt: fixture.exportedAt,
    simulatedFrom: times[0] ?? "", simulatedTo: times[times.length - 1] ?? "",
    wallMinutes,
    orders: { total: 100, investigated: new Set(backfill.map((run) => run.order_id)).size, quietChecks: runs.filter((run) => run.agent === "Quiet check").length },
    investigator: {
      runs: backfill.length, cards: cards.filter((card) => ids.has(card.run_id)).map((card) => card.run_id).filter((id, index, list) => list.indexOf(id) === index).length, closed: closed.length,
      sonnet: backfill.filter((run) => run.model === MODELS.sonnet).length, opus: backfill.filter((run) => run.model === MODELS.opus).length,
      safety: reason("Safety"), conflict: reason("Conflicting evidence"), overCost: backfill.filter((run) => /over €500/.test(String(run.escalation ?? ""))).length,
      totalUsd: cost(backfill), averageUsd: cost(backfill) / Math.max(1, backfill.length),
      medianSeconds: median(seconds), maxSeconds: Math.max(0, ...seconds),
      longestOrderId: String([...backfill].sort((a, b) => Number(b.wall_ms ?? 0) - Number(a.wall_ms ?? 0))[0]?.order_id ?? "") || null,
      closeSeconds: [Math.min(...closed.map((run) => Number(run.wall_ms) / 1000)), Math.max(...closed.map((run) => Number(run.wall_ms) / 1000))],
    },
    classifier: { runs: classifier.length, messages: steps.filter((step) => classifierIds.has(step.run_id) && step.type === "tool_result").length, usd: cost(classifier) },
    all: { runs: runs.filter((run) => run.model).length, usd: cost(runs), haikuUsd: byModel(MODELS.haiku), sonnetUsd: byModel(MODELS.sonnet), opusUsd: byModel(MODELS.opus) },
  }
  cached = { mtime, value }
  return value
}
