// A person's decision on a card. It is recorded at once (the card leaves the list,
// the timeline shows it), and carried out only after an 8-second undo window
// (SPEC 8): then the Executor runs an approved option, a reply goes back to the
// agent, a rejection becomes an eval case, and the policy counters move. Undo
// inside the window cancels everything; after it, the toast can no longer undo.

import { randomUUID } from "node:crypto"
import { and, eq, isNull, lt } from "drizzle-orm"
import { getCase } from "./case"
import { now as clockNow } from "./clock"
import { db } from "./db"
import { execute } from "./executor"
import { writeEntry } from "./agents/entries"
import { hasApiKey } from "./agents/llm"
import { countDecision } from "./policies"
import { agentRuns, cards, decisions, evalCases, timelineEntries } from "./schema"
import type { CardOption } from "./schema"

export const UNDO_SECONDS = 8

export class DecisionError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

type Kind = "approve" | "reject" | "reply" | "answer" | "handled"

function kindOf(option: CardOption): Kind {
  if (option.action === "mark_handled") return "handled"
  if (option.action === "reply") return "reply"
  if (option.kind === "reject" || option.action === "reject") return "reject"
  if (option.kind === "answer" || option.action === "answer") return "answer"
  return "approve"
}

const STATUS: Record<Kind, "approved" | "rejected" | "answered"> = {
  approve: "approved", reject: "rejected", reply: "answered", answer: "answered", handled: "answered",
}

/** "Booking in 8 s": what the toast counts down to. */
function pendingWord(kind: Kind, option: CardOption): string {
  if (kind === "reject") return "Rejecting"
  if (kind === "reply" || kind === "answer") return hasApiKey() ? "Sending to the agent" : "Recording your reply"
  if (kind === "handled") return "Marking as handled"
  const actions = (option.steps ?? [{ action: option.action }]).map((step) => step.action)
  if (actions.some((action) => action.startsWith("book_") || action === "change_ferry_booking")) return "Booking"
  if (actions.includes("message_customer")) return "Sending the email"
  if (actions.includes("call_customer") || actions.includes("call_contact")) return "Handing you the call"
  if (actions.includes("switch_driver")) return "Offering the gig"
  if (actions.some((action) => action.startsWith("change_"))) return "Changing the time"
  return "Carrying it out"
}

export async function decide(cardId: string, optionId: string, replyText: string | null, actor = "Ops") {
  const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1)
  if (!card) throw new DecisionError("This card no longer exists.", 404)
  if (card.status !== "open") throw new DecisionError("Someone already decided this card.", 409)
  const option: CardOption | undefined = optionId === "reply"
    ? { id: "reply", label: "Reply sent to the agent", action: "reply", params: {} }
    : card.options.find((candidate) => candidate.id === optionId)
  if (!option) throw new DecisionError("That option is not on this card.")
  const kind = kindOf(option)
  if (kind === "reply" && !replyText?.trim()) throw new DecisionError("Write the reply first.")

  const at = await clockNow()
  const decisionId = `dec_${randomUUID()}`
  const executeAfter = new Date(Date.now() + UNDO_SECONDS * 1000)
  const summary = kind === "handled" ? `Marked as handled: ${card.headline}`
    : kind === "reply" ? `Replied to the agent: “${replyText}”`
    : kind === "reject" ? `Rejected: ${card.headline.replace(/^[^:]+:\s*/, "")}${replyText ? `. “${replyText}”` : ""}`
    : `Approved: ${option.label.replace(/^Approve:\s*/i, "")}`
  await db.transaction(async (tx) => {
    await tx.insert(decisions).values({ id: decisionId, cardId, decidedAt: at, actor, choice: option.id, replyText: replyText ?? null, executedEffect: null, executeAfter })
    await tx.update(cards).set({ status: STATUS[kind] }).where(eq(cards.id, cardId))
    await tx.insert(timelineEntries).values({
      id: `decision:${decisionId}`, orderId: card.orderId, occurredAt: at, receivedAt: at, source: "person", channel: "control_room",
      authorType: "operator", authorId: actor, authorLabel: actor, kind: "decision", summary, body: null, status: "done",
      visibility: "internal", evidence: { table: "decisions", id: decisionId }, origin: "live",
    })
  })
  // Carry it out when the window closes. The page also asks at that moment, and any page load sweeps overdue
  // decisions, so a restarted server still finishes the work.
  setTimeout(() => { void finalizeDecision(decisionId).catch((error) => console.error("finalize", error)) }, UNDO_SECONDS * 1000 + 250)
  const word = pendingWord(kind, option)
  return {
    decisionId, executesAt: executeAfter.toISOString(), pending: word,
    message: kind === "handled" ? "Marked as handled." : `${word} in ${UNDO_SECONDS} s`,
  }
}

type Window = { executeAfter: Date | null; finalizedAt: Date | null; undoneAt: Date | null }

/** Inside the undo window: nobody undid it, it was not carried out, and the 8 seconds have not passed (real time). */
export function canUndo(decision: Window, nowMs: number): boolean {
  return !decision.undoneAt && !decision.finalizedAt && !!decision.executeAfter && decision.executeAfter.getTime() >= nowMs
}

/** Due to be carried out: the window has closed, nobody undid it, and nobody carried it out yet. */
export function isDue(decision: Window, nowMs: number): boolean {
  return !decision.undoneAt && !decision.finalizedAt && (!decision.executeAfter || decision.executeAfter.getTime() <= nowMs)
}

export async function undo(decisionId: string) {
  const [decision] = await db.select().from(decisions).where(and(eq(decisions.id, decisionId), isNull(decisions.undoneAt))).limit(1)
  if (!decision) throw new DecisionError("Nothing to undo.", 404)
  if (!canUndo(decision, Date.now())) throw new DecisionError("This was already carried out and cannot be undone here.", 409)
  const at = await clockNow()
  await db.transaction(async (tx) => {
    await tx.update(decisions).set({ undoneAt: at }).where(eq(decisions.id, decisionId))
    await tx.update(cards).set({ status: "open" }).where(eq(cards.id, decision.cardId))
    await tx.delete(timelineEntries).where(eq(timelineEntries.id, `decision:${decisionId}`))
  })
  return { ok: true }
}

/** Carry out a decision whose undo window has closed. Safe to call more than once: only the first call does the work. */
export async function finalizeDecision(decisionId: string): Promise<{ done: boolean; ok?: boolean; summary?: string }> {
  const [decision] = await db.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1)
  if (!decision || !isDue(decision, Date.now())) return { done: false }
  // Claim it in one statement, so two callers cannot both execute.
  const claimed = await db.update(decisions).set({ finalizedAt: await clockNow() })
    .where(and(eq(decisions.id, decisionId), isNull(decisions.finalizedAt), isNull(decisions.undoneAt))).returning()
  if (!claimed.length) return { done: false }
  const [card] = await db.select().from(cards).where(eq(cards.id, decision.cardId)).limit(1)
  if (!card) return { done: false }
  const option: CardOption = decision.choice === "reply"
    ? { id: "reply", label: "Reply", action: "reply", params: {} }
    : card.options.find((candidate) => candidate.id === decision.choice) ?? { id: decision.choice, label: decision.choice, action: decision.choice, params: {} }
  const kind = kindOf(option)
  const primary = card.options.find((candidate) => candidate.kind !== "reject" && candidate.action !== "reject") ?? null
  const primaryActions = (primary?.steps ?? []).map((step) => step.action)

  if (kind === "handled") return { done: true, ok: true }

  if (kind === "approve") {
    const effect = await execute({ decisionId, orderId: card.orderId, option, actor: decision.actor })
    await db.update(decisions).set({ executedEffect: effect }).where(eq(decisions.id, decisionId))
    // "Approved unchanged" means the agent's own first proposal went through as written.
    for (const step of option.steps ?? []) await countDecision(step.action, option.id === primary?.id)
    const summary = effect.ok ? effect.steps.map((step) => step.summary).join("; ") : effect.steps.find((step) => !step.ok)?.summary ?? "Not carried out"
    if (card.runId) {
      if (effect.ok) {
        await db.update(agentRuns).set({ status: "done", outcomeSummary: `Approved by ${decision.actor} and carried out: ${option.label.replace(/^Approve:\s*/i, "")}`, finishedAt: await clockNow(), state: null }).where(eq(agentRuns.id, card.runId))
        void exportTraceSafe(card.runId)
      } else {
        // The agent hears what failed and can propose again.
        void resumeAgent(card.runId, `Ops approved "${option.label}", but the Executor could not carry it out: ${summary}. Nothing after that step was done. Look again and propose what to do now.`)
      }
    }
    return { done: true, ok: effect.ok, summary }
  }

  // Reject, reply and answer: the agent's proposal was not taken as written. That is a lesson worth keeping.
  for (const action of primaryActions) await countDecision(action, false)
  if (kind === "reject" || kind === "reply") {
    const file = await getCase(card.orderId)
    await db.insert(evalCases).values({
      id: `eval_${randomUUID().slice(0, 12)}`, cardId: card.id, createdAt: await clockNow(),
      caseSnapshot: file ?? {}, agentProposal: { headline: card.headline, whatHappened: card.whatHappened, findings: card.findings, options: card.options },
      humanCorrection: { choice: kind, reply: decision.replyText, rejected: primary?.label ?? null },
    })
  }
  if (card.runId) {
    const reply = decision.replyText?.trim()
    if (kind === "answer") void resumeAgent(card.runId, `The person answered your question: "${option.label}". Continue.`)
    else if (kind === "reply") void resumeAgent(card.runId, `The person did not choose an option on your card. They wrote: "${reply}". Do what they ask if you can, then propose or resolve.`)
    else if (reply) void resumeAgent(card.runId, `The person rejected your proposal and wrote: "${reply}". Take that into account, then propose or resolve.`)
    else await db.update(agentRuns).set({ status: "done", outcomeSummary: `Proposal rejected by ${decision.actor}`, finishedAt: await clockNow(), state: null }).where(eq(agentRuns.id, card.runId))
  }
  return { done: true, ok: true }
}

/** Finish decisions whose undo window closed while nobody was watching (a closed tab, a restarted server). */
export async function sweepDecisions(): Promise<void> {
  const overdue = await db.select({ id: decisions.id }).from(decisions)
    .where(and(isNull(decisions.finalizedAt), isNull(decisions.undoneAt), lt(decisions.executeAfter, new Date())))
  for (const row of overdue) await finalizeDecision(row.id)
}

async function resumeAgent(runId: string, content: string): Promise<void> {
  // Without an API key (recorded runs only) no agent can continue: say so on the order instead of failing the run.
  if (!hasApiKey()) {
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
    if (!run) return
    await db.update(agentRuns).set({ status: "done", outcomeSummary: "Your answer is recorded. Agents are not running live here (no API key), so no agent continued with it.", finishedAt: await clockNow() }).where(eq(agentRuns.id, runId))
    if (run.orderId) await writeEntry({ orderId: run.orderId, at: await clockNow(), source: "system", channel: "control_room", authorType: "system", authorLabel: "Control room", kind: "event", summary: "Your answer is recorded. Agents are not running live here (no API key), so no agent continued with it.", evidence: { table: "agent_runs", id: runId } })
    return
  }
  try {
    const { continueAfterPerson } = await import("./agents/investigator")
    await continueAfterPerson(runId, content)
  } catch (error) {
    console.error("resume after decision", error)
  }
}

async function exportTraceSafe(runId: string): Promise<void> {
  try {
    const { exportTrace } = await import("./agents/runs")
    await exportTrace(runId)
  } catch (error) {
    console.error("trace export", error)
  }
}
