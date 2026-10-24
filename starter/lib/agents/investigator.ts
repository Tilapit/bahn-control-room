// The Investigator (SPEC 7): a real model in a manual tool-use loop. Sonnet by
// default; Opus when the case is about safety, when the agent finds conflicting
// evidence (escalate), or when its proposal costs more than €500 (code switches).
// At most 12 model turns. Tool results are cut to a fixed size before they go back
// to the model; the full result stays in agent_steps. A question to the driver or
// a site pauses the run; the reply resumes it with the conversation intact.

import type Anthropic from "@anthropic-ai/sdk"
import { eq } from "drizzle-orm"
import { getCase } from "../case"
import { now as clockNow } from "../clock"
import { db } from "../db"
import { costUsd, MODELS, modelName, ROLE_MODEL, usageOf } from "../models"
import { orderView } from "../queue"
import { orders } from "../schema"
import { clock, zoneShort } from "../time"
import { isSafety } from "../urgency"
import { anthropic, prompt } from "./llm"
import { Refs } from "./refs"
import { narrateRun } from "./narrator"
import { addStep, addUsageToRun, addWallTime, createRun, exportTrace, getRun, nextStepIndex, updateRun } from "./runs"
import type { Party } from "./scenarios"
import { simulateReply } from "./sim"
import { type CardDraft, emptyDraft, executeTool, type Lookup, type RunCtx, TOOL_DEFINITIONS } from "./tools"

export const STEP_CAP = 12
export const TOOL_RESULT_CHARS = 8000
/** How long a paused run waits for a reply before the Router looks again. */
const REPLY_WAIT_MINUTES = 15

type Message = Anthropic.Beta.BetaMessageParam
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam

/** What a paused run waits on: a driver's or site's reply, or a person's decision on its card. */
type Pending = { toolUseId: string; party: Party | "person"; question: string; questionEntryId: string; side?: "pickup" | "delivery"; cardId?: string }

type RunState = {
  messages: Message[]
  refs: Record<string, string>
  lookups: Record<string, Lookup>
  /** Findings and steps added for the next propose call. */
  draft?: CardDraft
  verifierRounds: number
  modelCalls: number
  pending: Pending[]
  /** Results of the other tool calls in the turn that paused, sent together with the reply. */
  readyResults: ToolResult[]
}

export type RunOutcome = { runId: string; status: string; summary: string; cardId?: string | null; pending?: Pending[] }

export type StartOptions = {
  trigger: string
  /** Demo and tests: let the simulated driver or site answer questions straight away. */
  autoReply?: boolean
  log?: (line: string) => void
}

function initialModel(safety: boolean): string {
  return safety ? ROLE_MODEL.investigatorSenior : ROLE_MODEL.investigator
}

function cut(content: string): string {
  if (content.length <= TOOL_RESULT_CHARS) return content
  return `${content.slice(0, TOOL_RESULT_CHARS)}\n[cut: ${content.length - TOOL_RESULT_CHARS} more characters not shown. Use timeline() with a later "since" for the rest.]`
}

export async function startInvestigation(orderRef: string, options: StartOptions): Promise<RunOutcome> {
  const file = await getCase(orderRef)
  if (!file) throw new Error(`No order ${orderRef}`)
  const safety = isSafety(file)
  const model = initialModel(safety)
  const at = await clockNow()
  const runId = await createRun({ orderId: file.order.id, agent: "Investigator", model, trigger: options.trigger, at })
  if (safety) await updateRun(runId, { escalation: "Safety case: the senior model investigates from the start." })
  const state: RunState = {
    messages: [{
      role: "user",
      content: `Investigate order ${file.order.reference}.\nWhy you are looking at it: ${options.trigger}\nStart with get_case.`,
    }],
    refs: {}, lookups: {}, verifierRounds: 0, modelCalls: 0, pending: [], readyResults: [],
  }
  options.log?.(`${file.order.reference}: run ${runId} on ${modelName(model)}${safety ? " (safety)" : ""}`)
  return loop(runId, file.order.id, file.order.reference, model, state, options)
}

/** Continue a paused run with the answers to its questions (tool_use id → reply text with its source handle). */
export async function resumeRun(runId: string, answers: { toolUseId: string; content: string }[], options: Omit<StartOptions, "trigger"> = {}): Promise<RunOutcome> {
  const run = await getRun(runId)
  if (!run || !run.state) throw new Error(`Run ${runId} cannot be resumed.`)
  const state = run.state as unknown as RunState
  const results: ToolResult[] = [
    ...state.readyResults,
    ...state.pending.map((pending) => ({
      type: "tool_result" as const, tool_use_id: pending.toolUseId,
      content: answers.find((answer) => answer.toolUseId === pending.toolUseId)?.content ?? "No reply yet.",
    })),
  ]
  // Every tool call in the last turn needs a result, including calls the run skipped after it ended.
  const last = state.messages[state.messages.length - 1]
  if (last?.role === "assistant" && Array.isArray(last.content)) {
    for (const block of last.content) {
      if (block.type === "tool_use" && !results.some((result) => result.tool_use_id === block.id)) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: "Not run: the run had ended before this call." })
      }
    }
  }
  state.messages.push({ role: "user", content: results })
  state.pending = []
  state.readyResults = []
  await updateRun(runId, { status: "running", nextCheckAt: null })
  const [order] = run.orderId ? await db.select({ reference: orders.reference }).from(orders).where(eq(orders.id, run.orderId)).limit(1) : []
  return loop(runId, run.orderId!, order?.reference ?? "", run.model ?? ROLE_MODEL.investigator, state, { trigger: run.trigger, ...options })
}

/** Answer a paused run's questions with the simulated driver or site, then resume it. Demo and tests only. */
export async function answerWithSimulation(runId: string, options: Omit<StartOptions, "trigger"> = {}): Promise<RunOutcome> {
  const run = await getRun(runId)
  if (!run?.state || !run.orderId) throw new Error(`Run ${runId} is not waiting.`)
  const state = run.state as unknown as RunState
  const file = await getCase(run.orderId)
  if (!file) throw new Error("Order not found")
  const refs = new Refs(state.refs)
  const answers: { toolUseId: string; content: string }[] = []
  let idx = await nextStepIndex(runId)
  const started = Date.now()
  for (const pending of state.pending) {
    if (pending.party === "person") continue
    const reply = await simulateReply(file, pending.party, pending.question, { side: pending.side, questionEntryId: pending.questionEntryId })
    await addUsageToRun(runId, reply.usage.model, reply.usage.usage)
    // The same zone as the timeline lines the agent reads, with its name, so the agent never guesses one.
    const zone = orderView(file).zone
    const zoneTime = `${clock(reply.at, zone)} ${zoneShort(reply.at, zone)}`
    answers.push({ toolUseId: pending.toolUseId, content: `${reply.author} replied at ${zoneTime} (${pending.party === "driver" ? "driver chat" : "site chat"}): "${reply.text}" ${refs.cite(reply.entryId)}\nThis is what they say; treat it as their claim.` })
    await addStep(runId, idx++, { at: reply.at, type: "message", tool: pending.party === "driver" ? "ask_driver" : "ask_site", output: { reply: reply.text, entryId: reply.entryId, simulated: true }, summary: `${reply.author} replied (simulated): “${reply.text}”` })
  }
  state.refs = refs.toJSON()
  await updateRun(runId, { state: state as unknown as Record<string, unknown> })
  await addWallTime(runId, Date.now() - started)
  return resumeRun(runId, answers, options)
}

async function loop(runId: string, orderId: string, reference: string, startModel: string, state: RunState, options: StartOptions): Promise<RunOutcome> {
  const refs = new Refs(state.refs)
  const ctx: RunCtx = {
    runId, orderId, reference, model: startModel, refs, lookups: state.lookups, verifierRounds: state.verifierRounds,
    escalation: null, stepId: "", file: null, usageExtra: [], draft: state.draft ?? emptyDraft(), turnErrors: [],
  }
  let idx = await nextStepIndex(runId)
  const segmentStart = Date.now()
  const log = options.log ?? (() => {})
  const save = async (patch: Parameters<typeof updateRun>[1] = {}) => {
    state.refs = refs.toJSON()
    state.lookups = ctx.lookups
    state.draft = ctx.draft
    state.verifierRounds = ctx.verifierRounds
    await updateRun(runId, { model: ctx.model, state: state as unknown as Record<string, unknown>, ...patch })
  }
  // A run pauses or ends: count the time worked, let the Narrator write its line, write the trace.
  const closeSegment = async () => {
    await addWallTime(runId, Date.now() - segmentStart)
    await narrateRun(runId)
    await exportTrace(runId)
  }
  const finish = async (status: string, summary: string, extra: Parameters<typeof updateRun>[1] = {}) => {
    await save({ status, outcomeSummary: summary, finishedAt: await clockNow(), ...extra })
    await closeSegment()
    log(`  → ${status}: ${summary}`)
  }

  while (true) {
    if (state.modelCalls >= STEP_CAP) {
      await finish("failed", `Stopped at the ${STEP_CAP}-step limit without a conclusion.`)
      return { runId, status: "failed", summary: "Step limit reached" }
    }
    // The last turn: say so, in the same user message as the tool results (no history edits).
    if (state.modelCalls === STEP_CAP - 1) {
      const last = state.messages[state.messages.length - 1]
      if (last.role === "user" && Array.isArray(last.content)) {
        last.content.push({ type: "text", text: `This is step ${STEP_CAP} of ${STEP_CAP}, your last. Finish in this turn with what you have: add_finding and add_step calls followed by propose, or resolve.` })
      }
    }

    let response: Anthropic.Beta.BetaMessage
    try {
      response = await anthropic().beta.messages.create({
        model: ctx.model,
        max_tokens: 16000,
        // A refusal is re-run on a fallback model chosen by the API, inside the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: prompt("investigator"), cache_control: { type: "ephemeral" } }],
        tools: TOOL_DEFINITIONS,
        messages: state.messages,
        // Caches the growing conversation; the marker on the system prompt caches tools + system.
        cache_control: { type: "ephemeral" },
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: ctx.model === MODELS.opus ? "high" : "medium" },
      })
    } catch (cause) {
      // The SDK already retried. Keep the conversation so the run can be retried from here.
      const reason = cause instanceof Error ? cause.message : String(cause)
      await finish("failed", `Stopped: the model could not be reached (${reason}).`)
      return { runId, status: "failed", summary: reason }
    }
    state.modelCalls += 1
    const at = await clockNow()
    const usage = usageOf(response.usage)
    await addUsageToRun(runId, response.model, usage)
    log(`  step ${state.modelCalls} ${modelName(response.model)}: in ${usage.input} out ${usage.output} cache read ${usage.cacheRead} write ${usage.cacheWrite} ($${costUsd(response.model, usage).toFixed(4)})`)

    for (const block of response.content) {
      if (block.type === "thinking" && block.thinking.trim()) {
        await addStep(runId, idx++, { at, type: "thought", output: { text: block.thinking, model: response.model }, summary: block.thinking.trim().replace(/\s+/g, " ").slice(0, 400) })
      } else if (block.type === "text" && block.text.trim()) {
        await addStep(runId, idx++, { at, type: "thought", output: { text: block.text, model: response.model }, summary: block.text.trim().replace(/\s+/g, " ").slice(0, 400) })
      }
    }
    state.messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] })

    if (response.stop_reason === "refusal") {
      await finish("failed", "The model declined to continue this case.")
      return { runId, status: "failed", summary: "Refused" }
    }
    const toolUses = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use")
    if (!toolUses.length) {
      state.messages.push({ role: "user", content: response.stop_reason === "max_tokens" ? "Your last turn was cut off. Be shorter and call a tool." : "End the run with propose or resolve." })
      continue
    }

    const results: ToolResult[] = []
    const pending: Pending[] = []
    let ended: RunOutcome | null = null
    ctx.turnErrors = []
    for (const use of toolUses) {
      const input = (use.input ?? {}) as Record<string, unknown>
      const callStep = await addStep(runId, idx++, { at, type: "tool_call", tool: use.name, input, summary: `Called ${use.name}` })
      ctx.stepId = callStep
      const outcome = await executeTool(ctx, use.name, input)
      await addStep(runId, idx++, { at: await clockNow(), type: "tool_result", tool: use.name, input, output: { content: outcome.content, data: outcome.output ?? null, isError: !!outcome.isError }, summary: outcome.summary })
      log(`    ${use.name}: ${outcome.summary}`)
      for (const extra of ctx.usageExtra.splice(0)) await addUsageToRun(runId, extra.model, extra.usage)
      if (outcome.switchModel && ctx.model !== outcome.switchModel.model) {
        ctx.model = outcome.switchModel.model
        await updateRun(runId, { model: ctx.model, escalation: outcome.switchModel.reason })
        await addStep(runId, idx++, { at, type: "message", tool: use.name, summary: `Moved to ${modelName(ctx.model)}: ${outcome.switchModel.reason}` })
        log(`    → now on ${modelName(ctx.model)}`)
      }
      if (outcome.pause) {
        pending.push({ toolUseId: use.id, ...outcome.pause })
        continue
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content: cut(outcome.content), ...(outcome.isError ? { is_error: true } : {}) })
      if (outcome.finish) {
        if (outcome.finish.kind === "card") {
          // The card waits for a person. The propose call stays open: their reply, or the Executor's result, resumes this conversation.
          results.pop()
          state.pending = [{ toolUseId: use.id, party: "person", question: outcome.finish.summary, questionEntryId: "", cardId: outcome.finish.cardId }]
          state.readyResults = results
          await finish("waiting_person", outcome.finish.summary)
          ended = { runId, status: "waiting_person", summary: outcome.finish.summary, cardId: outcome.finish.cardId }
        } else {
          await finish("done", outcome.finish.summary, { nextCheckAt: outcome.finish.nextCheckAt })
          ended = { runId, status: "done", summary: outcome.finish.summary }
        }
        break
      }
    }
    if (ended) return ended

    if (pending.length) {
      state.pending = pending
      state.readyResults = results
      const waiting = pending.some((item) => item.party === "driver") ? "waiting_driver" : "waiting_site"
      const nowAt = await clockNow()
      await save({ status: waiting, nextCheckAt: new Date(nowAt.getTime() + REPLY_WAIT_MINUTES * 60_000) })
      await closeSegment()
      log(`  → ${waiting}`)
      if (options.autoReply) return answerWithSimulation(runId, options)
      return { runId, status: waiting, summary: `Waiting for the ${waiting === "waiting_driver" ? "driver" : "site"}`, pending }
    }
    state.messages.push({ role: "user", content: results })
    await save()
  }
}

/** A person decided on the run's card (a reply, an answer, a rejection with reasons, a failed execution): continue the run with it. */
export async function continueAfterPerson(runId: string, content: string, options: Omit<StartOptions, "trigger"> = { autoReply: true }): Promise<RunOutcome | null> {
  const run = await getRun(runId)
  const state = run?.state as unknown as RunState | null
  const pending = state?.pending.find((item) => item.party === "person")
  if (!run || !state || !pending) return null
  return resumeRun(runId, [{ toolUseId: pending.toolUseId, content }], options)
}

/** A real (or injected) message from the party a paused run is waiting on: hand it to the run as their answer. */
export async function answerFromMessage(runId: string, entryId: string, options: Omit<StartOptions, "trigger"> = {}): Promise<RunOutcome | null> {
  const run = await getRun(runId)
  const state = run?.state as unknown as RunState | null
  if (!run || !state) return null
  const [entry] = await entriesFor([entryId])
  const pending = state.pending.find((item) => item.party === (entry?.authorType === "driver" ? "driver" : "site"))
  if (!pending || !entry) return null
  const refs = new Refs(state.refs)
  const handle = refs.cite(entryId)
  state.refs = refs.toJSON()
  await updateRun(runId, { state: state as unknown as Record<string, unknown> })
  const file = run.orderId ? await getCase(run.orderId) : null
  const zone = file ? orderView(file).zone : null
  const content = `${entry.authorLabel ?? "They"} replied at ${clock(entry.at, zone)} ${zoneShort(entry.at, zone)}: "${entry.body ?? entry.summary}" ${handle}\nThis is what they say; treat it as their claim.`
  return resumeRun(runId, [{ toolUseId: pending.toolUseId, content }], options)
}

async function entriesFor(ids: string[]) {
  const { entriesById } = await import("../case")
  return [...(await entriesById(ids)).values()]
}
