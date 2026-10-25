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
  waiting_person: "waiting for an operations person to decide on its proposal",
  paused: "paused: a person took the order over and handles it",
  done: "finished",
  failed: "stopped without finishing",
}

/** Card-building steps are one action ("put a card together"), not one line each. */
const QUIET_TOOLS = new Set(["add_finding", "add_step"])
/** A pronoun guessed from a name misgenders a real person; the sentence is asked for again, then replaced by code's. */
const GUESSED_PRONOUN = /\b(he|she|him|her|his|hers|himself|herself)\b/i
const SENT_BACK = /^(Card sent back|Card held back|Close sent back|Card call arrived)/
/** Words from inside the app that a person should not read in the Agents view: the sentence is asked for again, then replaced by code's. */
const INTERNAL_WORDS = /\b(cards?|verifier|case files?|sent back|held back|by (?:the )?checks|code checks|handles? E\d+|\[?E\d+\]?)\b/i

export async function narrateRun(runId: string): Promise<string | null> {
  if (!hasApiKey()) return null
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  if (!run) return null
  const [steps, cardRows, orderRows] = await Promise.all([
    db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(asc(agentSteps.idx)),
    db.select().from(cards).where(and(eq(cards.runId, runId))).orderBy(desc(cards.createdAt)).limit(1),
    run.orderId ? db.select({ reference: orders.reference }).from(orders).where(eq(orders.id, run.orderId)).limit(1) : Promise.resolve([]),
  ])
  // A card that was sent back and then fixed is not the outcome; leave the send-backs out.
  const did = steps
    .filter((step) => (step.type === "tool_result" || step.type === "message") && !QUIET_TOOLS.has(step.tool ?? "") && step.summary && !SENT_BACK.test(step.summary))
    .map((step) => `- ${step.summary!.slice(0, 300)}`)
  const card = cardRows[0]
  const user = [
    `ORDER ${orderRows[0]?.reference ?? "(none)"}`,
    `AGENT ${run.agent} (${modelName(run.model)})`,
    `WHERE IT STANDS\nThe run is ${STATE[run.status] ?? run.status}.${run.outcomeSummary ? ` Outcome: ${run.outcomeSummary}` : ""}`,
    card ? `ITS PROPOSAL (shown to a person)\nHeadline: ${card.headline.replace(/^[^:]+:\s*/, "")}\nProposal: ${card.options[0]?.label ?? "none"}${card.status !== "open" ? `\nThe proposal is ${card.status}.` : ""}` : null,
    `WHY IT STARTED\n${run.trigger.slice(0, 600)}`,
    `WHAT IT DID, IN ORDER\n${did.slice(-14).join("\n") || "- nothing yet"}`,
  ].filter(Boolean).join("\n\n")
  const schema = { type: "object", additionalProperties: false, required: ["sentence"], properties: { sentence: { type: "string" } } }
  try {
    let sentence = ""
    for (const attempt of [0, 1]) {
      const result = await callJson<{ sentence: string }>({
        model: ROLE_MODEL.narrator, system: prompt("narrator"), effort: "low", maxTokens: 4000, schema,
        user: attempt === 0 ? user : `${user}\n\nYour last sentence ${GUESSED_PRONOUN.test(sentence) ? "used he, she, him, her or his. Refer to people by role or name only" : "used a word from inside the app (card, verifier, checks, sent back, case file). Say proposal, the order's records, and leave out drafts that were sent back"}: "${sentence}"`,
      })
      await addUsageToRun(runId, result.model, result.usage)
      sentence = result.value.sentence.trim().replace(/\s+/g, " ")
      if (!GUESSED_PRONOUN.test(sentence) && !INTERNAL_WORDS.test(sentence)) break
    }
    if (!sentence || GUESSED_PRONOUN.test(sentence) || INTERNAL_WORDS.test(sentence)) return null
    await updateRun(runId, { narration: sentence })
    return sentence
  } catch (cause) {
    console.error(`narrator ${runId}:`, cause instanceof Error ? cause.message : cause)
    return null
  }
}
