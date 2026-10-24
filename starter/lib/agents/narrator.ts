// The Narrator (SPEC 7, Haiku): one plain sentence per run for the Agents view.
// It reads what code already wrote about the run (the trigger, the step
// summaries, the outcome, the card) and never sees raw tool output. It runs when
// a run pauses or ends; a failure leaves the code-written outcome in place.

import { and, asc, desc, eq } from "drizzle-orm"
import { db } from "../db"
import { modelName, ROLE_MODEL } from "../models"
import { agentRuns, agentSteps, cards, orders } from "../schema"
import { callJson, hasApiKey, prompt } from "./llm"
import { addUsageToRun, updateRun } from "./runs"

const STATE: Record<string, string> = {
  running: "still working",
  waiting_driver: "waiting for the driver's reply",
  waiting_site: "waiting for the site's reply",
  waiting_person: "waiting for an operations person to decide on its card",
  done: "finished",
  failed: "stopped without finishing",
}

/** Card-building steps are one action ("put a card together"), not one line each. */
const QUIET_TOOLS = new Set(["add_finding", "add_step"])

export async function narrateRun(runId: string): Promise<string | null> {
  if (!hasApiKey()) return null
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  if (!run) return null
  const [steps, cardRows, orderRows] = await Promise.all([
    db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(asc(agentSteps.idx)),
    db.select().from(cards).where(and(eq(cards.runId, runId))).orderBy(desc(cards.createdAt)).limit(1),
    run.orderId ? db.select({ reference: orders.reference }).from(orders).where(eq(orders.id, run.orderId)).limit(1) : Promise.resolve([]),
  ])
  const did = steps
    .filter((step) => (step.type === "tool_result" || step.type === "message") && !QUIET_TOOLS.has(step.tool ?? "") && step.summary)
    .map((step) => `- ${step.summary!.slice(0, 300)}`)
  const card = cardRows[0]
  const user = [
    `ORDER ${orderRows[0]?.reference ?? "(none)"}`,
    `AGENT ${run.agent} (${modelName(run.model)})`,
    `WHY IT STARTED\n${run.trigger.slice(0, 600)}`,
    `WHAT IT DID, IN ORDER\n${did.slice(-14).join("\n") || "- nothing yet"}`,
    `WHERE IT STANDS\nThe run is ${STATE[run.status] ?? run.status}.${run.outcomeSummary ? ` Outcome: ${run.outcomeSummary}` : ""}`,
    card ? `ITS CARD\nHeadline: ${card.headline.replace(/^[^:]+:\s*/, "")}\nProposal: ${card.options[0]?.label ?? "none"}${card.status !== "open" ? `\nThe card is ${card.status}.` : ""}` : null,
  ].filter(Boolean).join("\n\n")
  try {
    const result = await callJson<{ sentence: string }>({
      model: ROLE_MODEL.narrator, system: prompt("narrator"), user, effort: "low", maxTokens: 4000,
      schema: { type: "object", additionalProperties: false, required: ["sentence"], properties: { sentence: { type: "string" } } },
    })
    await addUsageToRun(runId, result.model, result.usage)
    const sentence = result.value.sentence.trim().replace(/\s+/g, " ")
    if (!sentence) return null
    await updateRun(runId, { narration: sentence })
    return sentence
  } catch (cause) {
    console.error(`narrator ${runId}:`, cause instanceof Error ? cause.message : cause)
    return null
  }
}
