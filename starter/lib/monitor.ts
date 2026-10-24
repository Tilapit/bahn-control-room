// The Monitor: rules in code that notice problems nobody has reported yet, and
// start an agent before a driver or customer has to say anything. Each rule writes
// what it saw as a timeline entry with a deterministic id, so it never fires twice
// for the same thing, and records a short code run for the Agents view.

import { inArray } from "drizzle-orm"
import { type CaseFile, getCases } from "./case"
import { now as clockNow } from "./clock"
import { db } from "./db"
import { autoReplyEnabled } from "./demo"
import { activeDisruptions, matchDisruption, noticeLine } from "./disruptions"
import { addStep, createRun, updateRun } from "./agents/runs"
import { writeEntry } from "./agents/entries"
import { hasApiKey } from "./agents/llm"
import { timelineEntries } from "./schema"
import { at } from "./time"

export const MONITOR_AGENT = "Monitor"

export type MonitorHit = { rule: string; summary: string; orders: string[]; investigatorRunId?: string | null }

type Options = {
  /** Start the Investigator for what the rules found. Off: record the hits only (no API key, or a dry run). */
  startAgents?: boolean
  /** Wait for the agents to finish (scripts); otherwise they run in the background (the app). */
  wait?: boolean
  log?: (line: string) => void
}

async function existing(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  return new Set((await db.select({ id: timelineEntries.id }).from(timelineEntries).where(inArray(timelineEntries.id, ids))).map((row) => row.id))
}

/** One code run per hit, so the Agents view shows what the Monitor noticed and what it started. */
async function recordHit(file: CaseFile, now: Date, rule: string, checked: string, summary: string): Promise<string> {
  const runId = await createRun({ orderId: file.order.id, agent: MONITOR_AGENT, model: null, trigger: `Monitor rule: ${rule}`, at: now })
  await addStep(runId, 0, { at: now, type: "tool_result", tool: "monitor", input: { rule }, summary: checked })
  await updateRun(runId, { status: "done", finishedAt: now, outcomeSummary: summary, narration: summary })
  return runId
}

async function investigate(files: CaseFile[], trigger: string, options: Options): Promise<string | null> {
  if (!options.startAgents || !hasApiKey()) return null
  const { startInvestigation } = await import("./agents/investigator")
  const autoReply = await autoReplyEnabled()
  const run = startInvestigation(files[0].order.reference, { trigger, autoReply, group: files.length > 1 ? files.map((file) => file.order.id) : undefined, log: options.log })
  if (options.wait) return (await run).runId
  void run.catch((error) => console.error("monitor investigation", error))
  return "started"
}

// ---------------------------------------------------------------------------
// Rule: a disruption notice touches orders (strike, protest, road closure)
// ---------------------------------------------------------------------------

async function disruptionRule(files: CaseFile[], now: Date, options: Options): Promise<MonitorHit[]> {
  const hits: MonitorHit[] = []
  for (const notice of await activeDisruptions(now)) {
    const matches = matchDisruption(notice, files, now)
    const ids = matches.map((match) => `disruptions:${notice.id}:${match.file.order.id}`)
    const known = await existing(ids)
    const fresh = matches.filter((_, index) => !known.has(ids[index]))
    if (!fresh.length) continue
    for (const match of fresh) {
      await writeEntry({
        id: `disruptions:${notice.id}:${match.file.order.id}`,
        orderId: match.file.order.id, at: now, source: "alert", channel: "disruption_feed", authorType: "system", authorLabel: notice.sourceLabel,
        kind: "alert", status: "signal", visibility: "internal",
        summary: `Disruption notice from ${notice.sourceLabel}: ${notice.title}. ${match.effect}`,
        body: `${noticeLine(notice)}\nThis is the feed's notice, matched to this order by the Monitor. No driver or site has confirmed it.`,
        evidence: { table: "disruptions", id: notice.id },
      })
    }
    const references = fresh.map((match) => match.file.order.reference)
    const trigger = [
      `Monitor: ${notice.sourceLabel} reports "${notice.title}" (${at(notice.startsAt, notice.timezone)} to ${at(notice.endsAt, notice.timezone)}), published ${notice.publishedAt ? at(notice.publishedAt, notice.timezone) : "now"}.`,
      `Matched by code to ${fresh.length === 1 ? "one order" : `${fresh.length} orders with this one cause`}:`,
      ...fresh.map((match) => `- ${match.file.order.reference}: ${match.effect}`),
      "No driver, site or customer has reported it. Check what it means for each order before anyone is affected.",
    ].join("\n")
    const runId = await investigate(fresh.map((match) => match.file), trigger, options)
    const summary = `Matched "${notice.title}" (${notice.sourceLabel}) to ${references.join(", ")}${runId ? "; the Investigator is looking into it" : "; no agent started"}.`
    for (const match of fresh) await recordHit(match.file, now, "disruption notice", `Checked ${notice.title} against routes, pickups, deliveries and drivers' booked trains.`, summary)
    hits.push({ rule: "disruption", summary, orders: references, investigatorRunId: runId })
    options.log?.(summary)
  }
  return hits
}

/** Run every rule once against the current simulated time. */
export async function runMonitor(options: Options = {}): Promise<MonitorHit[]> {
  const now = await clockNow()
  const files = await getCases()
  return [...await disruptionRule(files, now, options)]
}
