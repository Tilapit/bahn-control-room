// Search / ask (SPEC 8.4): a question typed into ⌘K goes to the Investigator in
// read-only mode. It may read cases, timelines and search, and answers in a few
// sentences with the entries it rests on. Nothing is written to any order.

import type Anthropic from "@anthropic-ai/sdk"
import { entriesById, getCase } from "../case"
import { now as clockNow } from "../clock"
import { modelName, ROLE_MODEL, usageOf } from "../models"
import { relative } from "../time"
import { anthropic, hasApiKey, prompt } from "./llm"
import { Refs } from "./refs"
import { addStep, addUsageToRun, addWallTime, createRun, updateRun } from "./runs"
import { emptyDraft, executeTool, type RunCtx, TOOL_DEFINITIONS } from "./tools"

const READ_TOOLS = new Set(["get_case", "timeline", "search"])
const STEP_CAP = 6

const ANSWER_TOOL: Anthropic.Beta.BetaTool = {
  name: "answer",
  description: "Give the person your answer and end. One to four plain sentences, with the handles of the entries it rests on.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The answer, one to four sentences." },
      sources: { type: "array", items: { type: "string" }, description: "Handles such as E12, most important first." },
    },
    required: ["text", "sources"],
  },
  cache_control: { type: "ephemeral" },
}
const TOOLS = [...TOOL_DEFINITIONS.filter((tool) => READ_TOOLS.has(tool.name)).map(({ cache_control: _c, ...tool }) => tool), ANSWER_TOOL] as Anthropic.Beta.BetaTool[]

/** One record the answer rests on, with its source and time ("Driver · 25 min ago"), like every fact shown to a person. */
export type AskSource = { label: string; at: string; when: string; reference: string | null; entryId: string; summary: string }
export type AskResult = { answer: string; sources: AskSource[]; model: string; costUsd: number; runId: string | null }

/** Does this read like a question for the agents rather than a search for an order? */
export function isQuestion(text: string): boolean {
  const value = text.trim()
  return value.endsWith("?") || /^(why|what|when|where|who|how|is|are|was|were|does|do|did|can|could|should|will|which|has|have)\b/i.test(value) || value.split(/\s+/).length >= 6
}

export async function ask(question: string): Promise<AskResult> {
  if (!hasApiKey()) {
    return { answer: "Asking needs the agents to be connected, and this copy runs without an API key: it shows recorded agent runs only. Search still works: type a reference, plate, name or city.", sources: [], model: "none", costUsd: 0, runId: null }
  }
  const mentioned = question.match(/CD-\d{6}/i)?.[0]?.toUpperCase() ?? null
  const file = mentioned ? await getCase(mentioned) : null
  const started = Date.now()
  const at = await clockNow()
  const model = ROLE_MODEL.investigator
  const runId = await createRun({ orderId: file?.order.id ?? null, agent: "Ask", model, trigger: `Question from Ops: “${question}”`, at })
  const refs = new Refs()
  const ctx: RunCtx = {
    runId, orderId: file?.order.id ?? "", reference: file?.order.reference ?? "", model, refs, lookups: {}, verifierRounds: 0, escalation: null, stepId: "",
    file, usageExtra: [], draft: emptyDraft(), turnErrors: [], group: file ? [file.order.id] : [], trigger: "Question from Ops", noReplySince: null,
  }
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: `Question from an operations person: “${question}”${file ? `\nIt names ${file.order.reference}; start with get_case for it.` : "\nIf it names no order, use search to find the orders it is about."}` }]
  let idx = 0
  let answer: { text: string; sources: string[] } | null = null
  for (let step = 0; step < STEP_CAP && !answer; step += 1) {
    const response = await anthropic().beta.messages.create({
      model, max_tokens: 8000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      system: [{ type: "text", text: prompt("ask"), cache_control: { type: "ephemeral" } }],
      tools: TOOLS, messages, cache_control: { type: "ephemeral" },
      thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "low" },
    })
    await addUsageToRun(runId, response.model, usageOf(response.usage))
    messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] })
    const uses = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use")
    if (!uses.length) { messages.push({ role: "user", content: "Call answer now." }); continue }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const use of uses) {
      const input = (use.input ?? {}) as Record<string, unknown>
      if (use.name === "answer") {
        // Handles belong in sources, not in the text a person reads.
        const text = String(input.text ?? "").replace(/\s*\[(?:E\d+(?:,\s*)?)+\]/g, "").trim()
        const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).length
        if (sentences > 5 && step < STEP_CAP - 1) {
          results.push({ type: "tool_result", tool_use_id: use.id, content: `Too long: ${sentences} sentences. Answer again in at most four, keeping the sources.`, is_error: true })
          continue
        }
        answer = { text, sources: Array.isArray(input.sources) ? input.sources.map(String) : [] }
        results.push({ type: "tool_result", tool_use_id: use.id, content: "Shown to the person." })
        continue
      }
      // Read-only: only the reading tools run here, whatever the model asks for.
      const outcome = READ_TOOLS.has(use.name) ? await executeTool(ctx, use.name, input) : { content: "Not available when answering a question: you can only read.", summary: `Refused ${use.name}`, isError: true }
      await addStep(runId, idx++, { at: await clockNow(), type: "tool_result", tool: use.name, input, output: { content: outcome.content }, summary: outcome.summary })
      results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content.slice(0, 8000), ...(outcome.isError ? { is_error: true } : {}) })
    }
    messages.push({ role: "user", content: results })
  }
  const text = answer?.text || "The agent could not find an answer in the records within its steps."
  const ids = (answer?.sources ?? []).map((handle) => refs.resolve(handle)).filter((id): id is string => !!id)
  const entries = await entriesById(ids)
  const references = new Map<string, string>()
  for (const entry of entries.values()) if (entry.orderId && !references.has(entry.orderId)) references.set(entry.orderId, (await getCase(entry.orderId))?.order.reference ?? "")
  const asOf = await clockNow()
  const sources = ids.map((id) => entries.get(id)).filter((entry) => !!entry).map((entry) => ({ label: entry!.chip, at: entry!.at, when: relative(entry!.at, asOf), reference: entry!.orderId ? references.get(entry!.orderId) ?? null : null, entryId: entry!.id, summary: entry!.summary }))
  await addStep(runId, idx++, { at: await clockNow(), type: "message", tool: "answer", output: { text, sources: ids }, summary: `Answered: ${text}` })
  await addWallTime(runId, Date.now() - started)
  const finished = await updateRunAndRead(runId, text, question)
  return { answer: text, sources, model: modelName(model), costUsd: finished, runId }
}

async function updateRunAndRead(runId: string, text: string, question: string): Promise<number> {
  await updateRun(runId, { status: "done", finishedAt: await clockNow(), outcomeSummary: `Answered “${question}”: ${text}`, narration: `Answered a question from Ops: “${question.length > 90 ? `${question.slice(0, 87)}…` : question}”` })
  const { getRun } = await import("./runs")
  return (await getRun(runId))?.costUsd ?? 0
}
