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
