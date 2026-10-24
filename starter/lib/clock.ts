// The simulated clock. The dataset is a snapshot at 2026-10-21T09:00:00Z and the
// app's "now" starts there. Business logic asks this module for the time and
// never reads the real clock. The demo page moves it forward.

import { eq } from "drizzle-orm"
import { db } from "./db"
import { demoSettings, simClock } from "./schema"

export const SNAPSHOT_AT = new Date("2026-10-21T09:00:00Z")
const ROW = "main"

/** The current simulated time. */
export async function now(): Promise<Date> {
  const [row] = await db.select().from(simClock).where(eq(simClock.id, ROW)).limit(1)
  return row?.nowAt ?? SNAPSHOT_AT
}

export async function setNow(at: Date): Promise<Date> {
  await db.insert(simClock).values({ id: ROW, nowAt: at })
    .onConflictDoUpdate({ target: simClock.id, set: { nowAt: at } })
  return at
}

export async function advance(minutes: number): Promise<Date> {
  const current = await now()
  return setNow(new Date(current.getTime() + minutes * 60_000))
}

export async function resetClock(): Promise<Date> {
  return setNow(SNAPSHOT_AT)
}

/**
 * Where the demo starts: the time the recorded morning of agent work ended (set by the backfill and by
 * loading the fixtures), or the snapshot. Going back further would put that work in the future.
 */
export async function demoStart(): Promise<Date> {
  const [row] = await db.select().from(demoSettings).where(eq(demoSettings.key, "start_clock")).limit(1)
  return typeof row?.value === "string" ? new Date(row.value) : SNAPSHOT_AT
}

export async function setDemoStart(at: Date): Promise<void> {
  await db.insert(demoSettings).values({ key: "start_clock", value: at.toISOString() })
    .onConflictDoUpdate({ target: demoSettings.key, set: { value: at.toISOString() } })
}

export async function resetToDemoStart(): Promise<Date> {
  return setNow(await demoStart())
}
