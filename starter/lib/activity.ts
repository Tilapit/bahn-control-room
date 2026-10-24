// A cheap "has anything changed?" number: pages refresh themselves when agents or
// people change something. Read by the SSE stream (and the polling fallback).

import { sql } from "drizzle-orm"
import { db } from "./db"

export async function activityVersion(): Promise<string> {
  const [row] = await db.execute<{ version: string }>(sql`
    select concat_ws(':',
      (select count(*) from agent_runs), (select count(*) from agent_runs where status in ('running','waiting_driver','waiting_site')),
      (select count(*) from agent_runs where narration is not null), (select count(*) from agent_steps),
      (select count(*) from cards where status = 'open'), (select count(*) from decisions), (select count(*) from decisions where finalized_at is not null),
      (select count(*) from timeline_entries where origin = 'live'), (select count(*) from policies where level = 'auto'),
      (select max(now_at)::text from sim_clock)) as version`)
  return row?.version ?? ""
}
