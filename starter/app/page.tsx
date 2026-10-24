import type { Metadata } from "next"
import { connection } from "next/server"
import { sweepDecisions } from "@/lib/decisions"
import { autonomySuggestion } from "@/lib/autonomy"
import { getQueue, type QueueCounts } from "@/lib/queue"
import { AutonomySuggestion } from "./ui/autonomy-suggestion"
import { Queue } from "./ui/queue"

export const metadata: Metadata = { title: "For you" }

function countsLine(counts: QueueCounts): string {
  const parts = [`${counts.needYou} need${counts.needYou === 1 ? "s" : ""} you`]
  if (counts.handling) parts.push(`agents are handling ${counts.handling}`)
  if (counts.unattended) parts.push(`${counts.unattended} more with open items, no agent run yet`)
  parts.push(`nothing open on ${counts.quiet}`)
  if (counts.byRule) parts.push(`${counts.byRule} done without asking, under your rules`)
  return parts.join(" · ")
}

export default async function ForYou() {
  await connection()
  await sweepDecisions()
  const [{ now, items, counts }, suggestion] = await Promise.all([getQueue(), autonomySuggestion()])
  const others = [
    counts.handling ? `Agents are handling ${counts.handling} orders.` : null,
    counts.unattended ? `${counts.unattended} more have open items that no agent has looked at yet.` : null,
    `Nothing is open on ${counts.quiet} of ${counts.total} orders.`,
  ].filter(Boolean).join(" ")
  return <main className="content narrow">
    <div className="page-head">
      <div>
        <h1>For you</h1>
        <p className="page-sub">{countsLine(counts)}</p>
      </div>
    </div>
    {suggestion && <AutonomySuggestion suggestion={suggestion} />}
    <Queue items={items} now={now} emptyLine={others} />
  </main>
}
