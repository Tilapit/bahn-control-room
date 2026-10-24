// Driver support (SPEC 7, Sonnet): answers a driver's routine question from the
// case file, in the driver's language, and hands anything that needs a person or
// an investigation to the Investigator with what it found. Replying to a driver is
// allowed without approval (policy reply_driver); it never contacts a customer.

import type Anthropic from "@anthropic-ai/sdk"
import { getCase } from "../case"
import { now as clockNow } from "../clock"
import { ROLE_MODEL, usageOf } from "../models"
import { levelFor } from "../policies"
import { caseText } from "./case-text"
import { writeEntry } from "./entries"
import { anthropic, prompt } from "./llm"
import { Refs } from "./refs"
import { addStep, addUsageToRun, createRun, exportTrace, updateRun } from "./runs"

const STEP_CAP = 5
export const DRIVER_SUPPORT_LABEL = "Driver support agent"

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_case",
    description: "Read the order's case file: car, route, sites and their handover rules, contacts, key times, bookings, open items and the latest messages. Free. Call it first.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "reply_driver",
    description: "Send the driver a chat message. Allowed without approval for routine answers from the records.",
    input_schema: { type: "object", properties: { text: { type: "string", description: "The message, in the driver's language." } }, required: ["text"] },
  },
  {
    name: "hand_off",
    description: "Hand the case to the Investigator, who can ask, look up and bring a person a decision. Use it for safety, decisions only a person can make, or questions the records do not answer.",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string", description: "What the driver asked and what you found, in two sentences." }, why: { type: "string" } },
      required: ["summary", "why"],
    },
    cache_control: { type: "ephemeral" },
  },
]

export type SupportOutcome = { runId: string; status: "replied" | "handed_off" | "failed"; summary: string; handOff?: string }

export async function runDriverSupport(orderRef: string, messageEntryId: string, messageText: string): Promise<SupportOutcome> {
  const file = await getCase(orderRef)
  if (!file) throw new Error(`No order ${orderRef}`)
  const model = ROLE_MODEL.driverSupport
  const started = await clockNow()
  const runId = await createRun({ orderId: file.order.id, agent: "Driver support", model, trigger: `Driver wrote: “${messageText}”`, at: started })
  const refs = new Refs()
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: `The driver on order ${file.order.reference} wrote in the driver app:\n"${messageText}"\nAnswer them or hand over.` }]
  let idx = 0
  let replied: string | null = null
  for (let step = 0; step < STEP_CAP; step += 1) {
    let response: Anthropic.Beta.BetaMessage
    try {
      response = await anthropic().beta.messages.create({
        model, max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
        system: [{ type: "text", text: prompt("driver-support"), cache_control: { type: "ephemeral" } }],
        tools: TOOLS, messages, cache_control: { type: "ephemeral" },
        thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "low" },
      })
    } catch (cause) {
      await updateRun(runId, { status: "failed", finishedAt: await clockNow(), outcomeSummary: `Stopped: the model could not be reached (${cause instanceof Error ? cause.message : cause}).` })
      return { runId, status: "failed", summary: "Model unreachable" }
    }
    const at = await clockNow()
    const usage = usageOf(response.usage)
    await addUsageToRun(runId, response.model, usage)
    for (const block of response.content) {
      if (block.type === "thinking" && block.thinking.trim()) await addStep(runId, idx++, { at, type: "thought", output: { text: block.thinking }, summary: block.thinking.trim().slice(0, 400) })
    }
    messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] })
    const uses = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use")
    if (!uses.length) break
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const use of uses) {
      const input = (use.input ?? {}) as Record<string, string>
      await addStep(runId, idx++, { at, type: "tool_call", tool: use.name, input, summary: `Called ${use.name}` })
      if (use.name === "get_case") {
        const fresh = await getCase(file.order.id)
        results.push({ type: "tool_result", tool_use_id: use.id, content: fresh ? caseText(fresh, refs) : "Order not found." })
        await addStep(runId, idx++, { at, type: "tool_result", tool: use.name, summary: `Read the case file of ${file.order.reference}` })
      } else if (use.name === "reply_driver") {
        const text = String(input.text ?? "").trim()
        if (await levelFor("reply_driver") !== "auto") {
          results.push({ type: "tool_result", tool_use_id: use.id, content: "Replying to drivers needs a person's approval right now. Hand off instead.", is_error: true })
          continue
        }
        const entryId = await writeEntry({
          orderId: file.order.id, at, source: "driver_chat", channel: "driver_chat", authorType: "agent", authorLabel: DRIVER_SUPPORT_LABEL,
          kind: "message", summary: text, body: text, visibility: "public", evidence: { table: "agent_runs", id: runId },
        })
        replied = text
        results.push({ type: "tool_result", tool_use_id: use.id, content: `Sent to the driver ${refs.cite(entryId)}.` })
        await addStep(runId, idx++, { at, type: "tool_result", tool: use.name, output: { text, entryId }, summary: `Replied to the driver: “${text}”` })
      } else if (use.name === "hand_off") {
        const summary = String(input.summary ?? "").trim()
        await addStep(runId, idx++, { at, type: "tool_result", tool: use.name, output: input, summary: `Handed to the Investigator: ${summary}` })
        await updateRun(runId, { status: "done", finishedAt: at, outcomeSummary: `Handed to the Investigator: ${input.why ?? summary}` })
        await exportTrace(runId)
        return { runId, status: "handed_off", summary, handOff: `Driver support handed this over. ${summary} Why: ${input.why ?? ""}` }
      }
    }
    if (replied && !uses.some((use) => use.name === "get_case")) {
      await updateRun(runId, { status: "done", finishedAt: await clockNow(), outcomeSummary: `Answered the driver: “${replied}”` })
      await exportTrace(runId)
      return { runId, status: "replied", summary: replied }
    }
    messages.push({ role: "user", content: results })
  }
  await updateRun(runId, { status: replied ? "done" : "failed", finishedAt: await clockNow(), outcomeSummary: replied ? `Answered the driver: “${replied}”` : "Stopped without an answer" })
  await exportTrace(runId)
  return { runId, status: replied ? "replied" : "failed", summary: replied ?? "No answer" }
}
