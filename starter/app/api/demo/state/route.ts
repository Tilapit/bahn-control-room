import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { getCase } from "@/lib/case"
import { demoStart, now } from "@/lib/clock"
import { db } from "@/lib/db"
import { autonomyThreshold } from "@/lib/autonomy"
import { allAnswers, autoReplyEnabled } from "@/lib/demo"
import { replayState } from "@/lib/recording"
import { agentRuns, orders, timelineEntries } from "@/lib/schema"

/** Demo page state: the clock, the switch, one order's driver chat, and the latest agent runs. */
export async function GET(request: Request) {
  const reference = new URL(request.url).searchParams.get("order")
  const [clock, start, autoReply, replay, answers, threshold] = await Promise.all([now(), demoStart(), autoReplyEnabled(), replayState(), allAnswers(), autonomyThreshold()])
  let thread: { id: string; at: string; who: string; mine: boolean; text: string; simulated: boolean }[] = []
  let driver: string | null = null
  if (reference) {
    const file = await getCase(reference)
    if (file) {
      driver = file.order.driver?.name ?? null
      const rows = await db.select().from(timelineEntries)
        .where(and(eq(timelineEntries.orderId, file.order.id), eq(timelineEntries.kind, "message"), eq(timelineEntries.source, "driver_chat")))
        .orderBy(asc(timelineEntries.occurredAt), asc(timelineEntries.id))
      thread = rows.map((row) => ({
        id: row.id, at: row.occurredAt.toISOString(), who: row.authorLabel ?? "", mine: row.authorType === "driver",
        text: row.body ?? row.summary, simulated: row.evidence.table === "demo_events" && row.origin === "live",
      }))
    }
  }
  const runs = await db.select({ id: agentRuns.id, agent: agentRuns.agent, status: agentRuns.status, outcome: agentRuns.outcomeSummary, startedAt: agentRuns.startedAt, reference: orders.reference })
    .from(agentRuns).leftJoin(orders, eq(orders.id, agentRuns.orderId))
    .where(inArray(agentRuns.agent, ["Investigator", "Driver support", "Classifier"]))
    .orderBy(desc(agentRuns.startedAt), desc(agentRuns.id)).limit(8)
  return Response.json({ now: clock.toISOString(), start: start.toISOString(), autoReply, replay, answers, threshold, driver, thread, runs })
}
