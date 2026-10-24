// npm run agents:investigate -- CD-420322 [--fresh] [--keep-clock] [--no-reply] [--trigger "…"]
// Runs the Investigator on one order and prints what it did and the card it made.
// --fresh     forget earlier live work on this order first (runs, cards, live entries)
// --keep-clock  do not reset the simulated clock to the snapshot
// --no-reply  leave questions to the driver or site unanswered (the run waits)

import "dotenv/config"
import { asc, eq } from "drizzle-orm"
import { getCase } from "@/lib/case"
import { resetClock } from "@/lib/clock"
import { closeDb, db } from "@/lib/db"
import { startInvestigation } from "@/lib/agents/investigator"
import { resetOrderLiveState } from "@/lib/agents/reset"
import { getRun } from "@/lib/agents/runs"
import { modelName } from "@/lib/models"
import { ensurePolicies } from "@/lib/policies"
import { agentSteps, cards } from "@/lib/schema"
import { liveSignals } from "@/lib/signals"

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] ?? null : null
}

async function main() {
  const args = process.argv.slice(2)
  const reference = args.find((arg) => /^CD-\d+$/i.test(arg))
  if (!reference) throw new Error("Usage: npm run agents:investigate -- CD-420322 [--fresh] [--keep-clock] [--no-reply]")
  await ensurePolicies()
  if (!args.includes("--keep-clock")) await resetClock()
  const before = await getCase(reference)
  if (!before) throw new Error(`No order ${reference}`)
  if (args.includes("--fresh")) await resetOrderLiveState(before.order.id)
  const file = (await getCase(reference))!
  const trigger = option(args, "--trigger") ?? `Open signals on this order: ${liveSignals(file).join("; ") || "none"}.`
  const started = Date.now()
  const outcome = await startInvestigation(reference, { trigger, autoReply: !args.includes("--no-reply"), log: (line) => console.log(line) })
  const run = await getRun(outcome.runId)
  console.log(`\n${reference} · ${run?.status} · ${modelName(run?.model)}${run?.escalation ? ` (${run.escalation})` : ""} · ${Math.round((Date.now() - started) / 1000)} s`)
  console.log(`tokens: in ${run?.inputTokens} out ${run?.outputTokens} cache read ${run?.cacheReadTokens} cache write ${run?.cacheWriteTokens} · $${run?.costUsd.toFixed(4)}`)
  const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, outcome.runId)).orderBy(asc(agentSteps.idx))
  console.log(`\nSTEPS`)
  for (const step of steps) if (step.type !== "tool_call") console.log(`  ${step.type === "thought" ? "·" : step.type === "message" ? "»" : "-"} ${step.summary?.slice(0, 260)}`)
  if (outcome.cardId) {
    const [card] = await db.select().from(cards).where(eq(cards.id, outcome.cardId))
    console.log(`\nCARD (${card.kind}, ${card.severity})\n${card.headline}\n${card.consequenceText}\n\n${card.whatHappened}\n`)
    for (const finding of card.findings) console.log(`  • ${finding.text}  [${finding.source_label} · ${finding.at}]`)
    console.log("")
    for (const opt of card.options) console.log(`  [${opt.label}]${opt.effect_text ? ` → ${opt.effect_text}` : ""}${opt.steps?.length ? `  {${opt.steps.map((step) => step.action).join(", ")}}` : ""}`)
    if (card.proposal?.requires_approval_reason) console.log(`  Needs approval: ${card.proposal.requires_approval_reason}${card.proposal.cost_eur ? ` · €${card.proposal.cost_eur}` : ""}`)
    console.log(`\nVERIFIER`)
    for (const note of card.verifierNotes ?? []) console.log(`  ${note.ok ? "ok " : "NO "} ${note.finding != null ? `#${note.finding + 1} ` : ""}${note.note}`)
  } else console.log(`\nOUTCOME: ${run?.outcomeSummary}`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDb)
