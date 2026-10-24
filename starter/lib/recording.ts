// Recorded scenarios (demo): a live scenario run is recorded as the rows it wrote,
// each with the real time it appeared, and can be played back at the same speed.
// Replayed runs are marked as replays everywhere they show. Nothing in a replay is
// generated: every row is what the agents wrote when the scenario ran live.

import { readFile, writeFile } from "node:fs/promises"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { now as clockNow, setNow } from "./clock"
import { db } from "./db"
import { demoSettings } from "./schema"

export const RECORDING_DIR = join(process.cwd(), "..", "fixtures", "recordings")

type Row = Record<string, unknown>
export type RecordedEvent = { t: number; table: string; row: Row }
export type Recording = { scenario: string; order: string; orderId: string; recordedAt: string; clockStart: string; durationMs: number; events: RecordedEvent[] }

/** The rows one order's scenario touches, per table. */
function watched(orderId: string): { table: string; key: string; where: string }[] {
  const id = orderId.replace(/'/g, "''")
  return [
    { table: "demo_events", key: "id", where: `order_id = '${id}'` },
    { table: "timeline_entries", key: "id", where: `order_id = '${id}' and origin = 'live'` },
    { table: "agent_runs", key: "id", where: `order_id = '${id}'` },
    { table: "agent_steps", key: "id", where: `run_id in (select id from agent_runs where order_id = '${id}')` },
    { table: "facts", key: "id", where: `order_id = '${id}' and origin in ('classifier', 'agent')` },
    { table: "cards", key: "id", where: `order_id = '${id}'` },
    { table: "sim_clock", key: "id", where: "true" },
  ]
}

async function snapshot(orderId: string): Promise<Map<string, { table: string; row: Row; json: string }>> {
  const out = new Map<string, { table: string; row: Row; json: string }>()
  for (const { table, key, where } of watched(orderId)) {
    const [result] = await db.execute<{ rows: Row[] }>(sql.raw(`select coalesce(json_agg(t), '[]'::json) as rows from (select * from ${table} where ${where}) t`))
    for (const row of result?.rows ?? []) out.set(`${table}:${String(row[key])}`, { table, row, json: JSON.stringify(row) })
  }
  return out
}

/**
 * Record what happens on an order while `start()` plays a scenario live, until `done()` says it has settled.
 * Rows that already exist when recording starts are the baseline and are not recorded.
 */
export async function recordScenario(options: { scenario: string; order: string; orderId: string; start: () => Promise<void>; done: () => Promise<boolean>; timeoutMs?: number; log?: (line: string) => void }): Promise<Recording> {
  const clockStart = await clockNow()
  const events: RecordedEvent[] = []
  let last = await snapshot(options.orderId)
  // The scenario's own reset deletes rows first; anything it writes after that is recorded from t = 0.
  const begin = Date.now()
  await options.start()
  const deadline = begin + (options.timeoutMs ?? 6 * 60_000)
  let settledSince: number | null = null
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const current = await snapshot(options.orderId)
    const t = Date.now() - begin
    for (const [key, item] of current) {
      if (last.get(key)?.json !== item.json) events.push({ t, table: item.table, row: item.row })
    }
    last = current
    if (await options.done()) {
      settledSince ??= Date.now()
      // A short grace period catches the narration and trace written after the card.
      if (Date.now() - settledSince > 4000) break
    } else settledSince = null
  }
  const recording: Recording = { scenario: options.scenario, order: options.order, orderId: options.orderId, recordedAt: new Date().toISOString(), clockStart: clockStart.toISOString(), durationMs: events.length ? events[events.length - 1].t : 0, events }
  mkdirSync(RECORDING_DIR, { recursive: true })
  await writeFile(join(RECORDING_DIR, `${options.scenario}.json`), `${JSON.stringify(recording)}\n`)
  options.log?.(`Recorded ${events.length} changes over ${Math.round(recording.durationMs / 1000)} s`)
  return recording
}

export async function readRecording(scenario: string): Promise<Recording | null> {
  try {
    return JSON.parse(await readFile(join(RECORDING_DIR, `${scenario}.json`), "utf8")) as Recording
  } catch {
    return null
  }
}

async function upsert(table: string, row: Row): Promise<void> {
  const json = JSON.stringify(table === "agent_runs" ? { ...row, replay: true } : row)
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from ${sql.identifier(table)} where id = ${String(row.id)}`)
    await tx.execute(sql`insert into ${sql.identifier(table)} select * from json_populate_record(null::${sql.identifier(table)}, ${json}::json)`)
  })
}

export type ReplayState = { scenario: string; order: string; startedAt: string; durationMs: number } | null

export async function replayState(): Promise<ReplayState> {
  const [row] = await db.select().from(demoSettings).where(eq(demoSettings.key, "replay")).limit(1)
  const state = (row?.value ?? null) as ReplayState
  if (!state) return null
  // A finished replay is no longer playing.
  return Date.now() - new Date(state.startedAt).getTime() > state.durationMs + 3000 ? null : state
}

/**
 * Play a recording back at the speed it was recorded. The caller has already reset the order.
 * The clock never moves backwards: it jumps to the recording's start only if it is earlier.
 */
export async function startReplay(recording: Recording): Promise<void> {
  const current = await clockNow()
  if (current.getTime() < new Date(recording.clockStart).getTime()) await setNow(new Date(recording.clockStart))
  const state: ReplayState = { scenario: recording.scenario, order: recording.order, startedAt: new Date().toISOString(), durationMs: recording.durationMs }
  await db.insert(demoSettings).values({ key: "replay", value: state }).onConflictDoUpdate({ target: demoSettings.key, set: { value: state } })
  const began = Date.now()
  void (async () => {
    for (const event of recording.events) {
      const wait = event.t - (Date.now() - began)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      try {
        if (event.table === "sim_clock") {
          const at = new Date(String(event.row.now_at))
          if (at.getTime() > (await clockNow()).getTime()) await setNow(at)
        } else await upsert(event.table, event.row)
      } catch (cause) {
        console.error(`replay ${recording.scenario} ${event.table}:`, cause instanceof Error ? cause.message : cause)
      }
    }
  })()
}
