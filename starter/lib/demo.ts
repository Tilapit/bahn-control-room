// Demo switches, stored in one small table so every server process sees the same value.

import { eq } from "drizzle-orm"
import { db } from "./db"
import { demoSettings } from "./schema"

/** Whether the simulated driver and sites answer agent questions by themselves. On unless switched off. */
export async function autoReplyEnabled(): Promise<boolean> {
  const [row] = await db.select().from(demoSettings).where(eq(demoSettings.key, "auto_reply")).limit(1)
  return row ? row.value === true : true
}

export async function setAutoReply(on: boolean): Promise<void> {
  await db.insert(demoSettings).values({ key: "auto_reply", value: on })
    .onConflictDoUpdate({ target: demoSettings.key, set: { value: on } })
}

export type Answers = "always" | "sometimes" | "never"

/** Demo: whether the simulated driver or site on an order answers agent questions (per scenario on the Demo page). */
export async function answersOn(orderRef: string): Promise<Answers> {
  const [row] = await db.select().from(demoSettings).where(eq(demoSettings.key, "answers")).limit(1)
  const value = (row?.value as Record<string, Answers> | undefined)?.[orderRef]
  return value === "sometimes" || value === "never" ? value : "always"
}

export async function setAnswersOn(orderRef: string, answers: Answers): Promise<void> {
  const [row] = await db.select().from(demoSettings).where(eq(demoSettings.key, "answers")).limit(1)
  const value = { ...((row?.value as Record<string, Answers> | undefined) ?? {}), [orderRef]: answers }
  await db.insert(demoSettings).values({ key: "answers", value }).onConflictDoUpdate({ target: demoSettings.key, set: { value } })
}

export async function allAnswers(): Promise<Record<string, Answers>> {
  const [row] = await db.select().from(demoSettings).where(eq(demoSettings.key, "answers")).limit(1)
  return (row?.value as Record<string, Answers> | undefined) ?? {}
}

/** Demo: a GPS fix from the driver app (authored, fictional). The numbers ride on the demo event; the case reads them. */
export async function writeDemoGps(orderId: string, at: Date, fix: { kmToGo: number; eta: Date | null; progress?: number | null }, zone: string | null): Promise<string> {
  const { writeDemoEvent, writeEntry } = await import("./agents/entries")
  const { at: when } = await import("./time")
  const eventId = await writeDemoEvent(orderId, "gps", {
    observed_at: at.toISOString(), received_at: at.toISOString(), distance_remaining_km: fix.kmToGo,
    estimated_delivery_at: fix.eta?.toISOString() ?? null, location_quality: "COARSE",
  }, at)
  return writeEntry({
    orderId, at, source: "gps", channel: "driver_app", authorType: "system", authorLabel: "Driver app", kind: "position",
    summary: `Coarse app position: ${fix.kmToGo} km to go${fix.progress != null ? ` (${fix.progress}% of the drive)` : ""}${fix.eta ? `, ETA ${when(fix.eta, zone)}` : ""}`,
    visibility: "internal", evidence: { table: "demo_events", id: eventId },
  })
}
