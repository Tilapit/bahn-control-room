import type { Metadata } from "next"
import { connection } from "next/server"
import { sweepDecisions } from "@/lib/decisions"
import { autonomySuggestion } from "@/lib/autonomy"
import { getQueue, type QueueCounts } from "@/lib/queue"
import { AutonomySuggestion } from "./ui/autonomy-suggestion"
import { Queue } from "./ui/queue"

export const metadata: Metadata = { title: "For you" }

/** The header's one line: what needs you now, what can wait, and what agents are handling without you. */
function countsLine(counts: QueueCounts, now: number, later: number): string {
  const parts = [`${now} need${now === 1 ? "s" : ""} you now`, `${later} can wait`]
  if (counts.yours) parts.push(`${counts.yours} you took over`)
  if (counts.handling) parts.push(`agents are handling ${counts.handling}`)
  if (counts.unattended) parts.push(`${counts.unattended} not looked at yet`)
  parts.push(`nothing open on ${counts.quiet}`)
  return parts.join(" · ")
}

export default async function ForYou({ searchParams }: { searchParams: Promise<{ case?: string }> }) {
  await connection()
  await sweepDecisions()
  const initial = (await searchParams).case ?? null
  const [{ now, items, counts, yoursWithoutCard }, suggestion] = await Promise.all([getQueue(), autonomySuggestion()])
  // Now: a person's safety, or something lost within 4 hours or already lost (the same test as the list's sections).
  const open = items.filter((item) => !item.takenOver)
  const nowCount = open.filter((item) => item.urgency.safety || item.urgency.timeRisk).length
  const others = [
    counts.decided ? `You decided ${counts.decided} in the last day.` : null,
    counts.handling ? `Agents are handling ${counts.handling} orders.` : null,
    counts.unattended ? `${counts.unattended} more have open items that no agent has looked at yet.` : null,
    `Nothing is open on ${counts.quiet} of ${counts.total} orders.`,
  ].filter(Boolean).join(" ")
  return <main className="content inbox-page">
    <div className="page-head">
      <div>
        <h1>For you</h1>
        <p className="page-sub" title="Each case is something an agent could not settle on its own, most urgent first. Nothing happens until you press a button, and you can undo for 8 seconds.">{countsLine(counts, nowCount, open.length - nowCount)}</p>
      </div>
    </div>
    {suggestion && <AutonomySuggestion suggestion={suggestion} />}
    <Queue items={items} now={now} initial={initial} emptyLine={others} endLine={`That is everything that needs you. ${others}`} yoursWithoutCard={yoursWithoutCard} />
  </main>
}
