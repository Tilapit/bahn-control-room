import type { Metadata } from "next"
import { connection } from "next/server"
import { sweepDecisions } from "@/lib/decisions"
import { autonomySuggestion } from "@/lib/autonomy"
import { getQueue, type QueueCounts } from "@/lib/queue"
import { AutonomySuggestion } from "./ui/autonomy-suggestion"
import { Queue } from "./ui/queue"

export const metadata: Metadata = { title: "For you" }

/** The end of the header's one line, after what the view decides (now, elsewhere, can wait): the same for every view. */
function countsTail(counts: QueueCounts): string[] {
  const parts: string[] = []
  if (counts.yours) parts.push(`${counts.yours} you took over`)
  if (counts.handling) parts.push(`agents are handling ${counts.handling}`)
  if (counts.unattended) parts.push(`${counts.unattended} not looked at yet`)
  parts.push(`nothing open on ${counts.quiet}`)
  return parts
}

export default async function ForYou({ searchParams }: { searchParams: Promise<{ case?: string }> }) {
  await connection()
  await sweepDecisions()
  const initial = (await searchParams).case ?? null
  const [{ now, items, counts, yoursWithoutCard }, suggestion] = await Promise.all([getQueue(), autonomySuggestion()])
  const others = [
    counts.decided ? `You decided ${counts.decided} in the last day.` : null,
    counts.handling ? `Agents are handling ${counts.handling} orders.` : null,
    counts.unattended ? `${counts.unattended} more have open items that no agent has looked at yet.` : null,
    `Nothing is open on ${counts.quiet} of ${counts.total} orders.`,
  ].filter(Boolean).join(" ")
  return <main className="content inbox-page">
    <Queue items={items} now={now} initial={initial} tail={countsTail(counts)} emptyLine={others} endLine={`That is everything that needs you. ${others}`} yoursWithoutCard={yoursWithoutCard}
      hint="Each item is something an agent could not settle on its own, most urgent first. Nothing happens until you press a button, and you can undo for 8 seconds.">
      {suggestion && <AutonomySuggestion suggestion={suggestion} />}
    </Queue>
  </main>
}
