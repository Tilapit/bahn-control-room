// npm run agents:classify -- CD-420322   (or --all)
// Runs the Classifier over the messages of one order (or all orders) that it has
// not read yet, and prints what it filed. Routing is not triggered: this is the
// backfill path for messages that are already in the dataset.

import "dotenv/config"
import { and, eq, inArray, isNotNull } from "drizzle-orm"
import { classifyEntry } from "@/lib/agents/classifier"
import { getCase } from "@/lib/case"
import { closeDb, db } from "@/lib/db"
import { agentRuns, agentSteps, timelineEntries } from "@/lib/schema"

async function main() {
  const args = process.argv.slice(2)
  const reference = args.find((arg) => /^CD-\d+$/i.test(arg))
  if (!reference && !args.includes("--all")) throw new Error("Usage: npm run agents:classify -- CD-420322 | --all")
  const file = reference ? await getCase(reference) : null
  const messages = await db.select().from(timelineEntries)
    .where(and(eq(timelineEntries.kind, "message"), isNotNull(timelineEntries.orderId), file ? eq(timelineEntries.orderId, file.order.id) : undefined))
  // Already read: a Classifier step names the entry.
  const done = new Set((await db.select({ input: agentSteps.input }).from(agentSteps).innerJoin(agentRuns, eq(agentRuns.id, agentSteps.runId))
    .where(and(eq(agentRuns.agent, "Classifier"), inArray(agentSteps.tool, ["classify"])))).map((row) => String((row.input as { entryId?: string } | null)?.entryId)))
  // Oldest first, so a newer statement supersedes an older one. Our own agents' live messages are not facts.
  const todo = messages
    .filter((message) => !done.has(message.id) && !(message.origin === "live" && message.authorType === "agent"))
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
  console.log(`${todo.length} messages to classify (${messages.length - todo.length} already read)`)
  for (const message of todo) {
    const result = await classifyEntry(message.id, { trigger: "Backfill: message from the dataset" })
    if (!result) continue
    const c = result.classification
    console.log(`- ${message.authorLabel}: “${(message.body ?? message.summary).slice(0, 90)}”\n    ${c.intent}, ${c.urgency}, needs ${c.needs}${c.facts.length ? `\n${c.facts.map((fact) => `    ${fact.kind === "agreement" ? "AGREEMENT" : "fact"}: ${fact.subject}: ${fact.value}`).join("\n")}` : ""}`)
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDb)
