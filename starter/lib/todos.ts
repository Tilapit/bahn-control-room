// To-dos (asked for by Bahn's ops person): when a person approves a card whose option includes a step they do
// themselves, a call (call_customer, call_contact), the call stays on For you under Mine as "To do: call <contact>"
// until they log what happened. Code decides what is a to-do and refuses a log without words; Haiku (the
// Classifier) reads the note into facts and agreements; then the agent continues on the order with the note.

import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import { getCase } from "./case"
import { now as clockNow } from "./clock"
import { db } from "./db"
import { writeEntry } from "./agents/entries"
import { callJson, hasApiKey, prompt } from "./agents/llm"
import { addStep, addUsageToRun, createRun, updateRun } from "./agents/runs"
import { ROLE_MODEL } from "./models"
import { agentRuns, cards, decisions, todoLogs } from "./schema"
import type { CardOption, CardStep } from "./schema"
import { simulatedCall } from "./sim-call"
import { agentBlockedOn } from "./takeover"

export const CALL_ACTIONS = ["call_customer", "call_contact"] as const
export type CallAction = typeof CALL_ACTIONS[number]

/** At least this many characters of what happened: "ok" or "done" is not a log. */
export const MIN_NOTE = 8

export type Todo = {
  /** The decision that handed the person the call. */
  id: string
  cardId: string
  orderId: string
  reference: string
  car: string
  route: string
  contact: string
  action: CallAction
  /** The call script the agent wrote, when it wrote one. */
  script: string | null
  approvedAt: string
  by: string
}

export class TodoError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

/** The call a person makes in this option, if any: the step that makes an approved card a to-do. */
export function callStep(option: Pick<CardOption, "action" | "params" | "steps"> | null | undefined): (CardStep & { action: CallAction }) | null {
  if (!option) return null
  const steps = option.steps?.length ? option.steps : [{ action: option.action, params: option.params }]
  const step = steps.find((candidate) => (CALL_ACTIONS as readonly string[]).includes(candidate.action))
  return step ? step as CardStep & { action: CallAction } : null
}

type DecisionState = { choice: string; finalizedAt: Date | null; undoneAt: Date | null; executedEffect: unknown }

/**
 * A to-do is open when the decision was carried out after its undo window (not undone, the Executor reported ok),
 * the chosen option includes a call the person makes, and nobody has logged the call yet. Code decides; no model.
 */
export function isOpenTodo(decision: DecisionState, options: CardOption[], logged: boolean): boolean {
  if (logged || decision.undoneAt || !decision.finalizedAt) return false
  const effect = decision.executedEffect as { ok?: boolean } | null
  if (!effect?.ok) return false
  return !!callStep(options.find((option) => option.id === decision.choice))
}

/** Why a log cannot be accepted, or null. Checked before anything is written. */
export function noteError(note: string | null | undefined): string | null {
  const text = (note ?? "").trim()
  if (!text) return "Write what happened on the call first: who you spoke to and what you agreed."
  if (text.length < MIN_NOTE) return "Write a little more: who you spoke to and what you agreed."
  return null
}

/** "Marvellin Motorhandel (service contact)" reads "Marvellin Motorhandel": the heading needs only who. */
function contactOf(step: CardStep, customer: string): string {
  const to = typeof step.params.to === "string" ? step.params.to.replace(/\s*\(.*\)\s*$/, "").trim() : ""
  return to || (step.action === "call_customer" ? customer : "the contact")
}

const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}…`

/** Every call a person was handed and has not logged yet, newest first. */
export async function openTodos(): Promise<Todo[]> {
  const rows = await db.select({ decision: decisions, card: cards }).from(decisions).innerJoin(cards, eq(cards.id, decisions.cardId))
    .where(and(isNotNull(decisions.finalizedAt), isNull(decisions.undoneAt))).orderBy(desc(decisions.decidedAt))
  if (!rows.length) return []
  const logged = new Set((await db.select({ id: todoLogs.decisionId }).from(todoLogs).where(inArray(todoLogs.decisionId, rows.map((row) => row.decision.id)))).map((row) => row.id))
  const todos: Todo[] = []
  for (const { decision, card } of rows) {
    if (!isOpenTodo(decision, card.options, logged.has(decision.id))) continue
    const step = callStep(card.options.find((option) => option.id === decision.choice))!
    const file = await getCase(card.orderId)
    if (!file) continue
    const { order } = file
    todos.push({
      id: decision.id, cardId: card.id, orderId: card.orderId, reference: order.reference, car: order.car.label,
      route: `${order.route.from?.city ?? "?"} → ${order.route.to?.city ?? "?"}`,
      contact: contactOf(step, order.customer.name), action: step.action,
      script: typeof step.params.text === "string" && step.params.text.trim() ? step.params.text.trim() : null,
      approvedAt: decision.decidedAt.toISOString(), by: decision.actor,
    })
  }
  return todos
}

export type TodoResult = { ok: true; message: string; entryId: string | null; facts: number }

/**
 * Log what happened on the call. Refused without words, before anything is written. Then: one timeline entry in the
 * person's words (source Call), the Classifier (Haiku) files the facts and agreements it states, and the agent
 * continues on the order with the note. Once per to-do: a second log returns the first.
 */
export async function logTodo(id: string, note: string, actor = "Ops"): Promise<TodoResult> {
  const refused = noteError(note)
  if (refused) throw new TodoError(refused)
  const text = note.trim()
  const [row] = await db.select({ decision: decisions, card: cards }).from(decisions).innerJoin(cards, eq(cards.id, decisions.cardId)).where(eq(decisions.id, id)).limit(1)
  if (!row) throw new TodoError("This to-do no longer exists.", 404)
  const [existing] = await db.select().from(todoLogs).where(eq(todoLogs.decisionId, id)).limit(1)
  if (existing) return { ok: true, message: "Already logged.", entryId: existing.entryId, facts: existing.factsCount ?? 0 }
  if (!isOpenTodo(row.decision, row.card.options, false)) throw new TodoError("This is not a call waiting to be logged.", 409)
  const step = callStep(row.card.options.find((option) => option.id === row.decision.choice))!
  const file = await getCase(row.card.orderId)
  const contact = contactOf(step, file?.order.customer.name ?? "the customer")
  const at = await clockNow()

  // Claim it first, so two clicks cannot log the same call twice.
  const claimed = await db.insert(todoLogs).values({ decisionId: id, orderId: row.card.orderId, note: text, loggedAt: at, actor }).onConflictDoNothing().returning()
  if (!claimed.length) return { ok: true, message: "Already logged.", entryId: null, facts: 0 }

  // The person's own words, on the order's timeline: a statement, like any message.
  const entryId = await writeEntry({
    id: `todo:${id}`, orderId: row.card.orderId, at, source: "call", channel: "call_log", authorType: "operator", authorId: actor, authorLabel: actor,
    kind: "message", status: "claimed", summary: `${actor} called ${contact}: “${clip(text, 160)}”`, body: text, evidence: { table: "todo_logs", id },
  })
  let facts = 0
  let read = false
  if (hasApiKey()) {
    try {
      const { classifyEntry } = await import("./agents/classifier")
      const result = await classifyEntry(entryId, { trigger: `${actor} logged a call with ${contact}` })
      facts = result?.factIds.length ?? 0
      read = !!result
    } catch (error) {
      console.error("todo classify", error)
    }
  }
  await db.update(todoLogs).set({ entryId, factsCount: facts }).where(eq(todoLogs.decisionId, id))

  const filed = read ? (facts ? ` The Classifier filed ${facts} fact${facts === 1 ? "" : "s"} from it.` : " The Classifier found no new fact in it.") : ""
  const content = `${actor} made the call you proposed (${contact}) and logged what happened, in their words: "${text}".${filed} Read the order again with get_case, then propose or resolve.`
  const next = await continueOnOrder(row.card.orderId, row.card.runId, content)
  return { ok: true, message: `Logged on the order's timeline.${filed} ${next}`, entryId, facts }
}

/**
 * End a simulated call (the demo's scripted phone, lib/sim-call.ts, fictional). The transcript is the script's first
 * `played` lines, taken on the server, never text from the browser. Haiku summarises it, and the summary is logged
 * through the same path as a typed log: the timeline (source Call), the Classifier's facts, then the agent.
 */
export async function callTodo(id: string, played: number, actor = "Ops"): Promise<TodoResult> {
  const [row] = await db.select({ decision: decisions, card: cards }).from(decisions).innerJoin(cards, eq(cards.id, decisions.cardId)).where(eq(decisions.id, id)).limit(1)
  if (!row) throw new TodoError("This to-do no longer exists.", 404)
  const file = await getCase(row.card.orderId)
  const script = file ? simulatedCall(file.order.reference) : null
  if (!script) throw new TodoError("There is no simulated call for this order; log what happened instead.")
  const lines = script.lines.slice(0, Math.max(0, Math.min(script.lines.length, Math.floor(played))))
  if (!lines.some((line) => line.who === "them")) throw new TodoError("Nobody has answered yet; let the call play before ending it.")
  const transcript = lines.map((line) => `${line.who === "you" ? actor : script.them}: ${line.text}`).join("\n")
  // Without a model the log is what the other side said, word for word.
  let summary = lines.filter((line) => line.who === "them").map((line) => line.text).join(" ")
  if (hasApiKey()) {
    try {
      const at = await clockNow()
      const runId = await createRun({ orderId: row.card.orderId, agent: "Classifier", model: ROLE_MODEL.classifier, trigger: `Summarised ${actor}'s simulated call with ${script.them}`, at })
      const result = await callJson<{ summary: string }>({
        model: ROLE_MODEL.classifier, system: prompt("call-summary"), user: `CALL (simulated) between ${actor} at Bahn and ${script.them}\n${transcript}`,
        schema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" } } }, effort: "low",
      })
      await addUsageToRun(runId, result.model, result.usage)
      await addStep(runId, 0, { at, type: "tool_result", tool: "summarise_call", input: { transcript }, output: result.value, summary: `Summarised the simulated call with ${script.them}` })
      await updateRun(runId, { status: "done", finishedAt: await clockNow(), outcomeSummary: `Summarised the simulated call with ${script.them}` })
      if (result.value.summary.trim()) summary = result.value.summary.trim()
    } catch (error) {
      console.error("call summary", error)
    }
  }
  return logTodo(id, `Simulated call with ${script.them}. ${summary}`, actor)
}

/** The agent picks the order up again with the note: its waiting run if there is one, else a new look when something is still open. */
async function continueOnOrder(orderId: string, cardRunId: string | null, content: string): Promise<string> {
  const blocked = await agentBlockedOn([orderId])
  if (blocked) return "No agent continued: the order is taken over."
  if (!hasApiKey()) {
    await writeEntry({ orderId, at: await clockNow(), source: "system", channel: "control_room", authorType: "system", authorLabel: "Control room", kind: "event", summary: "The call log is recorded. Agents are not running live here (no API key), so no agent continued with it.", evidence: { table: "agent_runs", id: cardRunId ?? orderId } })
    return "Agents are not running live here (no API key), so no agent continued."
  }
  void (async () => {
    const { continueAfterHandBack, startInvestigation } = await import("./agents/investigator")
    const { autoReplyEnabled } = await import("./demo")
    const autoReply = await autoReplyEnabled()
    const [run] = await db.select().from(agentRuns)
      .where(and(eq(agentRuns.orderId, orderId), eq(agentRuns.agent, "Investigator"), inArray(agentRuns.status, ["paused", "waiting_driver", "waiting_site", "waiting_person"])))
      .orderBy(desc(agentRuns.startedAt)).limit(1)
    if (run && await continueAfterHandBack(run.id, content, { autoReply })) return
    const { liveSignals } = await import("./signals")
    const file = await getCase(orderId)
    if (file && liveSignals(file).length) await startInvestigation(file.order.reference, { trigger: `A person logged a call. ${content}`, autoReply })
  })().catch((error) => console.error("todo continue", error))
  return "The agent continues with your note."
}
