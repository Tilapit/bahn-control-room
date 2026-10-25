// The Investigator (SPEC 7): a real model in a manual tool-use loop. Sonnet by
// default; Opus when the case is about safety, when the agent finds conflicting
// evidence (escalate), or when its proposal costs more than €500 (code switches).
// At most 12 model turns. Tool results are cut to a fixed size before they go back
// to the model; the full result stays in agent_steps. A question to the driver or
// a site pauses the run; the reply resumes it with the conversation intact.

import { createHash } from "node:crypto"
import type Anthropic from "@anthropic-ai/sdk"
import { eq } from "drizzle-orm"
import { getCase } from "../case"
import { now as clockNow } from "../clock"
import { db } from "../db"
import { answersOn } from "../demo"
import { costUsd, MODELS, modelName, ROLE_MODEL, usageOf } from "../models"
import { orderView } from "../queue"
import { orders } from "../schema"
import { agentBlockedOn } from "../takeover"
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
type Pending = { toolUseId: string; party: Party | "person"; question: string; questionEntryId: string; side?: "pickup" | "delivery"; cardId?: string; orderId?: string }

type RunState = {
  messages: Message[]
  refs: Record<string, string>
  lookups: Record<string, Lookup>
  /** Findings and steps added for the next propose call. */
  draft?: CardDraft
  /** One cause, several orders: every order this run covers, the run's own order first. */
  group?: string[]
  /** The Monitor's no-reply rule: when it followed up, and since when nobody answers ("10:42"). */
  followUp?: { sentAt: string; askedAt: string }
  noReplySince?: string | null
  verifierRounds: number
  modelCalls: number
  pending: Pending[]
  /** Results of the other tool calls in the turn that paused, sent together with the reply. */
  readyResults: ToolResult[]
}

export type { RunState }

export type RunOutcome = { runId: string; status: string; summary: string; cardId?: string | null; pending?: Pending[] }

export type StartOptions = {
  trigger: string
  /** Demo and tests: let the simulated driver or site answer questions straight away. */
  autoReply?: boolean
  /** Order ids that share the cause (a disruption): the run covers all of them on one card. */
  group?: string[]
  log?: (line: string) => void
}

export function initialModel(safety: boolean): string {
  return safety ? ROLE_MODEL.investigatorSenior : ROLE_MODEL.investigator
}

function cut(content: string): string {
  if (content.length <= TOOL_RESULT_CHARS) return content
  return `${content.slice(0, TOOL_RESULT_CHARS)}\n[cut: ${content.length - TOOL_RESULT_CHARS} more characters not shown. Use timeline() with a later "since" for the rest.]`
}

export async function startInvestigation(orderRef: string, options: StartOptions): Promise<RunOutcome> {
  const file = await getCase(orderRef)
  if (!file) throw new Error(`No order ${orderRef}`)
  // Ops took the order over: no run starts on it until a person hands it back (lib/takeover.ts).
  const blocked = await agentBlockedOn([file.order.id, ...(options.group ?? [])])
  if (blocked) return { runId: "", status: "paused", summary: blocked }
  const safety = isSafety(file)
  const model = initialModel(safety)
  const at = await clockNow()
  const runId = await createRun({ orderId: file.order.id, agent: "Investigator", model, trigger: options.trigger, at })
  if (safety) await updateRun(runId, { escalation: "Safety case: the senior model investigates from the start." })
  const group = options.group && options.group.length > 1 ? [file.order.id, ...options.group.filter((id) => id !== file.order.id)] : undefined
  const others = group ? (await Promise.all(group.slice(1).map((id) => getCase(id)))).filter((item) => !!item).map((item) => item!.order.reference) : []
  const state: RunState = {
    messages: [{
      role: "user",
      content: group
        ? `Investigate orders ${[file.order.reference, ...others].join(", ")}. One cause touches all of them.\nWhy you are looking at them: ${options.trigger}\nStart with get_case for ${file.order.reference}, then get_case for each of the others. They go on one card: add_affected_order for each order, and give every step the order it is for.`
        : `Investigate order ${file.order.reference}.\nWhy you are looking at it: ${options.trigger}\nStart with get_case.`,
    }],
    refs: {}, lookups: {}, verifierRounds: 0, modelCalls: 0, pending: [], readyResults: [], group,
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
    // In a run that covers several orders, a question can go to another order's driver.
    const asked = pending.orderId && pending.orderId !== file.order.id ? await getCase(pending.orderId) ?? file : file
    // Demo: the simulated person can be set not to answer (always, or about every other question). The run then
    // waits like it would for a real person, and the Monitor's no-reply rule follows up and escalates.
    const willAnswer = await answersOn(asked.order.reference)
    if (willAnswer === "never" || (willAnswer === "sometimes" && parseInt(createHash("sha1").update(pending.questionEntryId).digest("hex").slice(0, 2), 16) % 2 === 0)) {
      await addStep(runId, idx++, { at: await clockNow(), type: "message", tool: pending.party === "driver" ? "ask_driver" : "ask_site", output: { reply: null }, summary: `No reply yet from the ${pending.party}.` })
      await addWallTime(runId, Date.now() - started)
      await updateRun(runId, { state: { ...state, refs: refs.toJSON() } as unknown as Record<string, unknown> })
      return { runId, status: run.status, summary: `Waiting for the ${pending.party}`, pending: state.pending }
    }
    let reply: Awaited<ReturnType<typeof simulateReply>>
    try {
      reply = await simulateReply(asked, pending.party, pending.question, { side: pending.side, questionEntryId: pending.questionEntryId })
    } catch (cause) {
      // The simulated person could not answer: the run is truly waiting for a reply, as it would for a real one.
      console.error(`simulated reply on ${runId}:`, cause instanceof Error ? cause.message : cause)
      await addWallTime(runId, Date.now() - started)
      return { runId, status: run.status, summary: `Waiting for the ${pending.party}`, pending: state.pending }
    }
    await addUsageToRun(runId, reply.usage.model, reply.usage.usage)
    // The same zone as the timeline lines the agent reads, with its name, so the agent never guesses one.
    const zone = orderView(asked).zone
    const zoneTime = `${clock(reply.at, zone)} ${zoneShort(reply.at, zone)}`
    const onOrder = asked.order.id !== file.order.id ? ` on ${asked.order.reference}` : ""
    answers.push({ toolUseId: pending.toolUseId, content: `${reply.author}${onOrder} replied at ${zoneTime} (${pending.party === "driver" ? "driver chat" : "site chat"}): "${reply.text}" ${refs.cite(reply.entryId)}\nThis is what they say; treat it as their claim.` })
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
    escalation: null, stepId: "", file: null, usageExtra: [], draft: { ...emptyDraft(), ...(state.draft ?? {}) }, turnErrors: [], group: state.group ?? [orderId], trigger: options.trigger, noReplySince: state.noReplySince ?? null,
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
    // Ops took the order over: the run stops before its next model call, with its conversation kept, until a person
    // hands the order back (continueAfterHandBack). Nothing reaches the model or the order meanwhile.
    const blocked = await agentBlockedOn(ctx.group)
    if (blocked) {
      await save({ status: "paused", nextCheckAt: null, outcomeSummary: `Paused: ${blocked}` })
      await addWallTime(runId, Date.now() - segmentStart)
      await exportTrace(runId)
      log(`  → paused: ${blocked}`)
      return { runId, status: "paused", summary: blocked }
    }
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

    const rules = await (await import("../learning")).playbookPrompt().catch(() => null)
    let response: Anthropic.Beta.BetaMessage
    try {
      response = await anthropic().beta.messages.create({
        model: ctx.model,
        max_tokens: 16000,
        // A refusal is re-run on a fallback model chosen by the API, inside the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // Approved playbook rules ride in their own cached block after the prompt, so the prompt's cache stays valid.
        system: [{ type: "text", text: prompt("investigator"), cache_control: { type: "ephemeral" } },
          ...(rules ? [{ type: "text" as const, text: rules, cache_control: { type: "ephemeral" as const } }] : [])],
        tools: TOOL_DEFINITIONS,
        messages: state.messages,
        // Caches the growing conversation; the marker on the system prompt caches tools + system.
        cache_control: { type: "ephemeral" },
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: ctx.model === MODELS.opus ? "high" : "medium" },
      })
    } catch (cause) {
      // The SDK already retried. Keep the conversation so the run can be retried from here.
      // People read a plain sentence; the API's own error stays in the step's details.
      const reason = cause instanceof Error ? cause.message : String(cause)
      await addStep(runId, idx++, { at: await clockNow(), type: "message", output: { error: reason }, summary: "The model could not be reached; the run stopped here. Nothing was changed." })
      await finish("failed", "Stopped: the agent could not reach the model. Nothing was changed; the order needs another run.")
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

/**
 * Ops handed a taken-over order back: the run continues with what the person did. A question still open (to the
 * driver, a site or a person) gets the note as its answer; a run paused between turns gets it as a new line.
 */
export async function continueAfterHandBack(runId: string, content: string, options: Omit<StartOptions, "trigger"> = { autoReply: true }): Promise<RunOutcome | null> {
  const run = await getRun(runId)
  const state = run?.state as unknown as RunState | null
  if (!run || !state || !run.orderId) return null
  if (state.pending.length) return resumeRun(runId, state.pending.map((item) => ({ toolUseId: item.toolUseId, content })), options)
  const last = state.messages[state.messages.length - 1]
  if (last?.role !== "user") return null
  last.content = typeof last.content === "string" ? `${last.content}\n\n${content}` : [...last.content, { type: "text", text: content }]
  await updateRun(runId, { status: "running", state: state as unknown as Record<string, unknown> })
  const [order] = await db.select({ reference: orders.reference }).from(orders).where(eq(orders.id, run.orderId)).limit(1)
  return loop(runId, run.orderId, order?.reference ?? "", run.model ?? ROLE_MODEL.investigator, state, { trigger: run.trigger, ...options })
}

/** A real (or injected) message from the party a paused run is waiting on: hand it to the run as their answer. */
export async function answerFromMessage(runId: string, entryId: string, options: Omit<StartOptions, "trigger"> = {}): Promise<RunOutcome | null> {
  const run = await getRun(runId)
  const state = run?.state as unknown as RunState | null
  if (!run || !state) return null
  const [entry] = await entriesFor([entryId])
  const party = entry?.authorType === "driver" ? "driver" : "site"
  // The question this message answers: the one to this party on the message's order.
  const pending = state.pending.find((item) => item.party === party && (item.orderId ?? run.orderId) === entry?.orderId) ?? state.pending.find((item) => item.party === party)
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
