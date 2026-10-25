// Recorded agent runs (SPEC 7): everything the agents, people and the Executor
// wrote live, exported to fixtures/agent-runs.json after the backfill, and loaded
// into a fresh database so the app shows real agent output without an API key.
// Rows go through Postgres's own JSON conversion, so every column round-trips.

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { db } from "./db"
import { setDemoStart, setNow } from "./clock"
import { SEED_DISRUPTIONS } from "./disruptions"
import { disruptions } from "./schema"

export const FIXTURE_FILE = join(process.cwd(), "..", "fixtures", "agent-runs.json")

/** Scale mode's synthetic orders are not part of the recorded morning: their rows are never exported, and a load keeps them. */
const REAL = "order_id is null or order_id not in (select id from orders where details ? 'synthetic_of')"

/**
 * Each table, and which of its rows are live work (the dataset's own rows are rebuilt by timeline:build). `clear` is
 * what a load deletes first when it differs from what an export writes: a step whose run is gone is never exported,
 * and is always cleared.
 */
const TABLES: { table: string; where: string; clear?: string }[] = [
  { table: "agent_runs", where: REAL },
  { table: "agent_steps", where: `run_id in (select id from agent_runs where ${REAL})`, clear: `run_id not in (select id from agent_runs where not (${REAL}))` },
  { table: "cards", where: REAL },
  { table: "decisions", where: "true" },
  { table: "past_decisions", where: "origin = 'live'" },
  { table: "eval_cases", where: "true" },
  { table: "timeline_entries", where: `origin = 'live' and (${REAL})` },
  { table: "facts", where: `origin in ('classifier', 'agent') and (${REAL})` },
  { table: "demo_events", where: REAL },
  { table: "policies", where: "true" },
  { table: "policy_changes", where: "true" },
  { table: "takeovers", where: REAL },
]

export type Fixture = { exportedAt: string; clock: string; tables: Record<string, Record<string, unknown>[]> }

export async function exportFixtures(file = FIXTURE_FILE): Promise<Record<string, number>> {
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const { table, where } of TABLES) {
    const [row] = await db.execute<{ rows: Record<string, unknown>[] }>(sql.raw(`select coalesce(json_agg(t), '[]'::json) as rows from (select * from ${table} where ${where} order by 1) t`))
    tables[table] = row?.rows ?? []
  }
  const [clockRow] = await db.execute<{ now_at: string }>(sql`select now_at from sim_clock limit 1`)
  const fixture: Fixture = { exportedAt: new Date().toISOString(), clock: new Date(clockRow?.now_at ?? "2026-10-21T09:00:00Z").toISOString(), tables }
  // One row per line: readable in a diff, and still one JSON document.
  const body = Object.entries(tables).map(([name, rows]) => `  ${JSON.stringify(name)}: [\n${rows.map((row) => `    ${JSON.stringify(row)}`).join(",\n")}\n  ]`).join(",\n")
  await writeFile(file, `{\n  "exportedAt": ${JSON.stringify(fixture.exportedAt)},\n  "clock": ${JSON.stringify(fixture.clock)},\n  "tables": {\n${body}\n  }\n}\n`)
  return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]))
}

/** Replace all live work with the recorded runs. The dataset tables are untouched. */
export async function loadFixtures(file = FIXTURE_FILE): Promise<Record<string, number>> {
  const fixture = JSON.parse(await readFile(file, "utf8")) as Fixture
  const counts: Record<string, number> = {}
  await db.transaction(async (tx) => {
    for (const { table, where, clear } of [...TABLES].reverse()) await tx.execute(sql.raw(`delete from ${table} where ${clear ?? where}`))
    for (const { table } of TABLES) {
      const rows = fixture.tables[table] ?? []
      counts[table] = rows.length
      // Insert in slices: one statement per few hundred rows keeps the parameter a sane size.
      for (let start = 0; start < rows.length; start += 400) {
        const slice = JSON.stringify(rows.slice(start, start + 400))
        await tx.execute(sql`insert into ${sql.identifier(table)} select * from json_populate_recordset(null::${sql.identifier(table)}, ${slice}::json)`)
      }
    }
  })
  await setNow(new Date(fixture.clock))
  await setDemoStart(new Date(fixture.clock))
  // Demo switches go back to their defaults: drivers answer, autonomy after 5 approvals, no replay playing.
  await db.execute(sql`delete from demo_settings where key in ('answers', 'autonomy_threshold', 'replay')`)
  // A notice the demo published (the Lille protest, scenario 7) leaves the feed again, or the Monitor would act on it unasked.
  for (const notice of SEED_DISRUPTIONS) await db.update(disruptions).set({ publishedAt: notice.publishedAt ?? null }).where(eq(disruptions.id, notice.id!))
  return counts
}
