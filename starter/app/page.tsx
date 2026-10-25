import type { Metadata } from "next"
import { connection } from "next/server"
import { sweepDecisions } from "@/lib/decisions"
import { autonomySuggestion } from "@/lib/autonomy"
import { getQueue, type QueueCounts } from "@/lib/queue"
import { AutonomySuggestion } from "./ui/autonomy-suggestion"
import { Queue } from "./ui/queue"

export const metadata: Metadata = { title: "For you" }

function countsLine(counts: QueueCounts): string {
  const parts = [`${counts.needYou} order${counts.needYou === 1 ? " needs" : "s need"} you`]
  if (counts.decided) parts.push(`you decided ${counts.decided} in the last day`)
  if (counts.handling) parts.push(`agents are handling ${counts.handling} more without you`)
  if (counts.unattended) parts.push(`${counts.unattended} more have open items no agent has looked at yet`)
  parts.push(`${counts.quiet} have nothing open`)
  if (counts.byRule) parts.push(`${counts.byRule} done without asking, under your rules`)
  return parts.join(" · ")
}

export default async function ForYou() {
  await connection()
  await sweepDecisions()
  const [{ now, items, counts }, suggestion] = await Promise.all([getQueue(), autonomySuggestion()])
  const others = [
    counts.decided ? `You decided ${counts.decided} in the last day.` : null,
    counts.handling ? `Agents are handling ${counts.handling} orders.` : null,
    counts.unattended ? `${counts.unattended} more have open items that no agent has looked at yet.` : null,
    `Nothing is open on ${counts.quiet} of ${counts.total} orders.`,
  ].filter(Boolean).join(" ")
  return <main className="content narrow">
    <div className="page-head">
      <div>
        <h1>For you</h1>
        <p className="page-sub">{countsLine(counts)}</p>
        <p className="page-explain">Each card is something an agent could not settle on its own, most urgent first, with what it proposes.
          Nothing happens until you press a button, and you can undo for 8 seconds.
          <span className="legend"><span className="mark safety" />safety <span className="mark time" />lost within 4 hours or already missed <span className="mark" />later</span></p>
      </div>
    </div>
    {suggestion && <AutonomySuggestion suggestion={suggestion} />}
    <Queue items={items} now={now} emptyLine={others} endLine={`That is everything that needs you. ${others}`} />
  </main>
}
