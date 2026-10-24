import { sql } from "drizzle-orm"
import { db } from "@/lib/db"

/** A cheap "has anything changed?" number for pages that refresh themselves while agents work. */
export async function GET() {
  const [row] = await db.execute<{ version: string }>(sql`
    select concat_ws(':',
      (select count(*) from agent_runs), (select count(*) from agent_runs where status in ('running','waiting_driver','waiting_site')),
      (select count(*) from cards where status = 'open'), (select count(*) from decisions), (select count(*) from timeline_entries where origin = 'live'),
      (select max(now_at)::text from sim_clock)) as version`)
  return Response.json({ version: row?.version ?? "" }, { headers: { "cache-control": "no-store" } })
}
