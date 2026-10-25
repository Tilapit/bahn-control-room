"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import type { QueueItem } from "@/lib/queue"
import { sourceKind } from "@/lib/sources"
import { problemPhrase } from "@/lib/status"
import { optionWords, stepList, type StepZones } from "@/lib/present/steps"
import type { CardOption, CardStep } from "@/lib/schema"
import { clock, long, relative, zoneShort } from "@/lib/time"
import { DecisionReason, EMPTY_REASON, type ReasonValue } from "./decision-reason"
import { SimilarCases } from "./similar-cases"
import { Icon } from "./icons"
import { TakenOverBar, TakeOverButton } from "./takeover"
import { CrossBorder, useTeamView } from "./view-switcher"
import { passesThrough } from "@/lib/teams"
import { SourceChip } from "./when"

/** A decision in its undo window. `reference` names the order, so two quick approvals never share one anonymous toast. */
export type Decided = { decisionId: string; cardId: string; message: string; executesAt?: string | null; reference?: string; car?: string; what?: string | null }

const orderHref = (reference: string) => `/orders/${reference}`
const entryHref = (reference: string, entryId: string) => `/orders/${reference}#${entryId}`

/** "Opus, the larger model": the model family, for the quiet line under an agent card. */
function modelWords(model: string | null): string {
  if (!model) return "a model"
  return model.includes("opus") ? "Opus, the larger model" : model.includes("sonnet") ? "Sonnet" : model.includes("haiku") ? "Haiku, the small model" : "a model"
}

const list = (parts: string[]) => parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`

/**
 * Why a person must approve, from the option's own steps: "it makes a booking and adds a cost, and you make a call".
 * A call is made by the person who approves, so it is "you", never "it". The stored reason is the fallback.
 */
function approvalWords(option: CardOption | null, reason: string): string {
  const actions = new Set((option?.steps ?? []).map((step) => step.action))
  const has = (...names: string[]) => names.some((name) => actions.has(name))
  const parts = [
    has("message_customer") ? "emails a customer" : null,
    has("book_ferry", "book_hotel", "book_driver_travel", "book_tow") ? "makes a booking" : null,
    has("change_ferry_booking", "cancel_driver_travel", "switch_driver", "republish_offer") ? "changes a booking" : null,
    has("raise_fee", "approve_repair_cost") || has("book_ferry", "book_hotel", "book_driver_travel", "book_tow") ? "adds a cost" : null,
    has("change_delivery_time") ? "changes the date the customer was promised" : has("change_pickup_time") ? "changes a date" : null,
  ].filter((part): part is string => !!part)
  const call = has("call_customer") ? "you call the customer" : has("call_contact") ? "you make a call" : null
  if (!parts.length && !call) return reason.replace(/^it a person makes the call/, "it hands the call to a person")
  return [parts.length ? `it ${list(parts)}` : null, call].filter(Boolean).join(parts.length && call ? ", and " : "")
}

/** A button names what it does: an answer to the agent's question says so, and every other approval starts with "Approve:". */
function buttonLabel(option: CardOption): string {
  if (/^(approve|reject|answer)\b/i.test(option.label)) return option.label
  // "Move ferry …" reads "Approve: move ferry …"; an acronym ("CMR …") keeps its capitals.
  const rest = /^\p{Lu}\p{Ll}/u.test(option.label) ? option.label.charAt(0).toLowerCase() + option.label.slice(1) : option.label
  return option.kind === "answer" ? `Answer: ${rest}` : option.kind === "reject" ? option.label : `Approve: ${rest}`
}

/** Cut at a word, never inside one: "Book the Sat 24 Oct 14:00 sailing and a…". */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  // A line never ends on a little word ("stopped on…"): it ends on the last word that carries meaning.
  const cut = text.slice(0, max + 1).replace(/[\s,;:·–-]+\S*$/, "").replace(/[\s,;:·–-]+$/, "")
  return `${cut.replace(/(\s+(on|at|in|the|and|of|to|a|an|for|with|by|from|or))+$/i, "")}…`
}

/** "BMW M4 · ferry sold out": the car and the problem, built by code from the headline. */
function problemLine(car: string, headline: string, group: number | null): string {
  return `${group ? `${group} orders` : car} · ${problemPhrase(headline) ?? headline}`
}

/** "11:14" today, "Mon 15:37" on another day: the left column of What we know, in the order's zone. */
function factTime(at: string, now: string, zone: string | null): string {
  const day = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value))
  return day(at) === day(now) ? clock(at, zone) : `${new Intl.DateTimeFormat("en-GB", { timeZone: zone ?? "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(at)).replace(",", "")} ${clock(at, zone)}`
}

/** The first sentence of what happened: the card's one-line summary. */
function firstSentence(text: string): string {
  const [first] = text.split(/(?<=[.!?])\s+(?=[A-Z“"])/)
  return first ?? text
}

/** The exact words that go to a customer or a driver, or the call script: one click away, never in the way. */
function Words({ step, customer }: { step: CardStep; customer: string }) {
  const text = typeof step.params.text === "string" ? step.params.text : null
  if (!text) return null
  // The agent's "to" can carry a description in brackets; the heading needs only who.
  const rawTo = typeof step.params.to === "string" && step.params.to ? step.params.to.replace(/\s*\(.*\)\s*$/, "") : customer
  const to = rawTo.replace(/^The /, "the ")
  const call = step.action === "call_customer" || step.action === "call_contact"
  const summary = step.action === "message_customer" ? `Show the email to ${to} (sent only if you approve)`
    : call ? `Show call script (${to})`
    : step.action === "message_driver" ? "Show message to driver"
    : null
  if (!summary) return null
  // An email to a customer is open from the start: approving sends exactly these words.
  return <details className="words" open={step.action === "message_customer"}>
    <summary>{summary}</summary>
    {call && <p className="h3-note">No phone numbers in this demo&apos;s records.</p>}
    <p>{text}</p>
  </details>
}

/** "If you approve": what happens, one short line per effect, built by code from the option's steps. */
function Effects({ option, zones }: { option: CardOption; zones: StepZones }) {
  const items = stepList(option, zones, true)
  if (!items.length) return option.effect_text ? <p>{option.effect_text}</p> : null
  return <ul className="effects">{items.map((text, index) => <li key={index}>{text}</li>)}</ul>
}

/** What the agent proposes, in its own button words without "Approve:": the second line of a list row. */
function proposalLine(item: QueueItem): string {
  const { card } = item
  if (card.kind === "question") return "The agent asks you a question"
  const primary = card.runId ? card.options.find((option) => option.kind !== "reject") ?? null : null
  const cost = card.proposal?.cost_eur ? ` · about €${Math.round(card.proposal.cost_eur)}` : ""
  if (primary) return `${primary.label.replace(/^approve:\s*/i, "")}${cost}`
  return card.proposal?.effect_text ? `Next step noted: ${card.proposal.effect_text}` : "Built from an alert; no agent has worked on it yet"
}

/**
 * One case in the For you list: two lines, no buttons. Line 1 is the car and the problem with the countdown on the
 * right; line 2, muted, is what the agent proposes, with the order number small on the right. Text is cut at a word.
 */
export function CaseListRow({ item, selected, onSelect }: { item: QueueItem; selected: boolean; onSelect: () => void }) {
  const { card, order, urgency } = item
  const tone = urgency.safety ? "safety" : urgency.timeRisk ? "time" : ""
  const [view] = useTeamView()
  // A row says "Cross-border" when it is in this view only because its route passes through the view's country.
  const through = passesThrough(item.team, view)
  return <li className="inbox-row" data-selected={selected} data-card={card.id}>
    <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined} title={card.headline}>
      <span className={`mark ${tone}`} aria-hidden="true" />
      <span className="inbox-line1">
        <span className="inbox-title">{clip(problemLine(order.car, card.headline, card.group?.length ?? null), urgency.safety ? 38 : 44)}</span>
        {urgency.safety && <span className="tag safety">Safety</span>}
        {item.takenOver && <span className="tag yours">Yours</span>}
        <span className={`when ${tone}`}>{urgency.relative}</span>
      </span>
      <span className="inbox-line2">
        <span className="inbox-proposal">{clip(proposalLine(item), through ? 42 : 54)}</span>
        {through && <CrossBorder team={item.team} />}
        <span className="row-ref">{card.group ? "" : order.reference}</span>
      </span>
    </button>
  </li>
}

/** A keyboard hint beside a button: quiet, and hidden on touch screens. */
const Key = ({ k }: { k: string }) => <kbd className="key-hint" aria-hidden="true">{k}</kbd>

/**
 * The selected case: what happened, what approving does, the buttons, then what we know with sources.
 * `keys` marks the buttons the For you shortcuts press (A approve, R reply, T take over).
 */
export function CaseDetail({ item, now, onOrderPage = false, keys = false, onDecided }: {
  item: QueueItem
  now: string
  /** On the order page the header already says what is wrong and when; the card shows only its body. */
  onOrderPage?: boolean
  keys?: boolean
  onDecided: (decided: Decided) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState("")
  const [answering, setAnswering] = useState(false)
  // Rejecting or changing the proposal needs one reason (the decision API refuses it without one).
  const [reason, setReason] = useState<ReasonValue>(EMPTY_REASON)
  const replyRef = useRef<HTMLInputElement>(null)
  const { card, order, urgency } = item
  const customer = order.customer
  const tone = urgency.safety ? "safety" : urgency.timeRisk ? "time" : ""
  const fromAgent = !!card.runId
  // Built by a Monitor rule in code (a driver cancelled a gig): a proposal, but no agent waits for a reply.
  const fromMonitor = card.origin === "monitor"
  const proposalSource = card.proposal?.params as { source_entry_id?: string; source_label?: string; source_at?: string } | undefined
  const primary = fromAgent ? card.options.find((option) => option.kind !== "reject") ?? null : null
  const others = fromAgent ? card.options.filter((option) => option !== primary && option.kind !== "reject") : []
  const rejects = card.options.filter((option) => option.kind === "reject")
  const notes = card.verifierNotes ?? []
  const failing = notes.filter((note) => !note.ok)
  const checked = notes.filter((note) => note.finding != null).length
  const question = card.kind === "question"

  // "R" opens the reply box and puts the cursor in it.
  useEffect(() => { if (answering) replyRef.current?.focus() }, [answering])

  async function decide(optionId: string, label: string, replyText?: string, withReason = false) {
    setBusy(optionId)
    setError(null)
    try {
      const response = await fetch(`/api/cards/${encodeURIComponent(card.id)}/decision`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionId, replyText: replyText ?? null, reason: withReason ? reason.reason : null, reasonText: withReason ? reason.text.trim() || null : null }),
      })
      const result = await response.json() as { decisionId?: string; message?: string; executesAt?: string | null; error?: string }
      if (!response.ok || !result.decisionId) throw new Error(result.error ?? "The decision was not saved.")
      const chosen = card.options.find((option) => option.id === optionId)
      onDecided({
        decisionId: result.decisionId, cardId: card.id, message: result.message ?? `${label}.`, executesAt: result.executesAt ?? null,
        reference: card.group ? `${card.group.length} orders` : order.reference, car: card.group ? undefined : order.car,
        what: chosen && chosen.kind !== "reject" ? optionWords(chosen, order.zones)?.replace(/ \(its text is in the card\)/, "") ?? null : null,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The decision was not saved.")
      setBusy(null)
    }
  }

  const timesIn = order.zone ? zoneShort(now, order.zone) : null
  const steps = primary?.steps ?? []
  const buttons = question ? card.options.filter((option) => option.kind !== "reject") : primary ? [primary] : card.options.filter((option) => option.kind !== "reject")

  return <article className="case-detail" aria-label={card.headline} data-card={card.id}>
    {!onOrderPage && <header className="cd-head">
      <h2>{problemLine(order.car, card.headline, card.group?.length ?? null)}{urgency.safety && <span className="tag safety">Safety</span>}{item.takenOver && <span className="tag yours">Yours</span>}</h2>
      <p className="cd-when"><span className={`when ${tone}`}>{urgency.sentence}</span></p>
      <p className="cd-meta">{card.group ? `${card.group.length} orders, one cause` : <>{order.reference} · {order.route} · {customer}</>}
        {!card.group && <CrossBorder team={item.team} />}{item.team.desk && <span>{item.team.desk} desk</span>}
        {!card.group && <Link className="cd-open" href={orderHref(order.reference)}>Open order<Icon name="arrow" size={14} /></Link>}</p>
    </header>}

    {item.takenOver && !onOrderPage && <TakenOverBar reference={order.reference} since={item.takenOver.at} by={item.takenOver.by} zone={order.zone} />}
    <p className="summary">{firstSentence(card.whatHappened)}</p>

    {card.group && <ul className="group-list">
      {card.group.map((member) => <li key={member.order_id}>
        <Link className="group-order" href={orderHref(member.reference)}>{member.reference} · {member.car}</Link>
        <span>{member.effect}</span>
      </li>)}
    </ul>}

    {fromAgent && primary && <div className="approve-box">
      <h3>{question ? "Agent asks you" : fromMonitor ? "If you approve (proposed by code)" : "If you approve"}</h3>
      {question ? <p>Pick the answer that is right; the agent carries on from it. Nothing is booked or sent.</p> : <Effects option={primary} zones={order.zones} />}
      {!question && (card.proposal?.cost_eur || card.proposal?.requires_approval_reason) && <p className="note">
        {card.proposal?.cost_eur ? `New cost about €${Math.round(card.proposal.cost_eur)}. ` : ""}
        {card.proposal?.requires_approval_reason ? `Needs your approval because ${approvalWords(primary, card.proposal.requires_approval_reason)}.` : ""}
        {steps.some((step) => step.action === "call_customer" || step.action === "call_contact") ? " Approving does not dial anyone: the call is yours, with the script below; the rest happens when you approve." : ""}
      </p>}
      {steps.map((step, index) => <Words key={index} step={step} customer={customer} />)}
    </div>}
    {!fromAgent && card.proposal && <div className="approve-box">
      <h3>Next step already noted</h3>
      <p>{card.proposal.effect_text} {proposalSource?.source_label && <SourceChip label={proposalSource.source_label} at={proposalSource.source_at ?? null} now={now} zone={order.zone}
        href={proposalSource.source_entry_id ? entryHref(order.reference, proposalSource.source_entry_id) : null} />}</p>
      <p className="note">Built by code from the alert and the order&apos;s records. No agent has worked on it yet.</p>
    </div>}

    <div className="row-actions">
      {buttons.map((option, index) => <button
        key={option.id} type="button" className={`btn${fromAgent ? " primary" : ""}`} disabled={!!busy}
        data-key={keys && fromAgent && !question && index === 0 ? "a" : undefined}
        onClick={() => decide(option.id, option.label)}>{busy === option.id ? "Saving…" : buttonLabel(option)}{keys && fromAgent && !question && index === 0 && <Key k="A" />}</button>)}
      {!onOrderPage && !item.takenOver && !card.group && <span className="key-wrap" data-key-host={keys ? "t" : undefined}><TakeOverButton reference={order.reference} className="btn" />{keys && <Key k="T" />}</span>}
      {(rejects.length > 0 || others.length > 0) && <button type="button" className="btn" aria-expanded={answering} data-key={keys ? "r" : undefined} onClick={() => setAnswering((value) => !value)}>
        {fromAgent && !fromMonitor ? "Reject or reply" : "Reject…"}{keys && <Key k="R" />}
      </button>}
      {error && <span className="note failed-note" role="alert">{error}</span>}
    </div>

    {answering && <div className="answer-box">
      {!question && <DecisionReason value={reason} onChange={setReason} disabled={!!busy} />}
      {others.map((option) => <div className="other-option" key={option.id}>
        <button type="button" className="btn small" disabled={!!busy || (!question && !reason.reason)} onClick={() => decide(option.id, option.label, undefined, !question)}>{busy === option.id ? "Saving…" : buttonLabel(option)}</button>
        <span className="note">If you choose it: {optionWords(option, order.zones) ?? option.effect_text}.</span>
      </div>)}
      <div className="answer-row">
        {rejects.map((option) => <button key={option.id} type="button" className="btn small" disabled={!!busy || !reason.reason} onClick={() => decide(option.id, option.label, undefined, true)}>{busy === option.id ? "Saving…" : buttonLabel(option)}</button>)}
      </div>
      {fromAgent && !fromMonitor && <form className="reply" onSubmit={(event) => { event.preventDefault(); if (reply.trim() && reason.reason) decide("reply", "Reply sent to the agent", reply.trim(), true) }}>
        <input ref={replyRef} value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Or tell the agent what to do instead" aria-label="Reply to the agent" />
        <button type="submit" className="btn small" disabled={!reply.trim() || !reason.reason || !!busy}>Send to agent</button>
      </form>}
    </div>}

    {/* What people decided on the same kind of proposal before, why, and whether it worked: next to the decision. */}
    {fromAgent && <SimilarCases cardId={card.id} />}

    {card.findings.length > 0 && <section>
      <h3>What we know{timesIn && <span className="h3-note">times {timesIn}</span>}</h3>
      <ul className="facts-compact">
        {card.findings.map((finding, index) => {
          const note = failing.find((candidate) => candidate.finding === index)
          const kind = sourceKind(finding.channel)
          const reference = finding.reference ?? order.reference
          return <li key={`${finding.source_entry_id}-${index}`}>
            <Link className="fact-src" href={entryHref(reference, finding.source_entry_id)} title={`${finding.reference ? `${finding.reference} · ` : ""}${finding.source_label} · ${long(finding.at, order.zone)} (${relative(finding.at, now)})`}>
              <Icon name={kind.icon} size={13} /><time dateTime={finding.at}>{factTime(finding.at, now, order.zone)}</time>
            </Link>
            <span className="fact-text">
              {finding.text}
              {note && <span className="finding-note">Not confirmed by the check: {note.note}</span>}
            </span>
          </li>
        })}
      </ul>
      {fromAgent && notes.length > 0 && (() => {
        const wrongFacts = failing.filter((note) => note.finding != null).length
        const remarks = failing.filter((note) => note.finding == null)
        return <div className="note verifier">
          <p>{wrongFacts === 0 ? `Each fact was checked against its source: all ${checked} match.` : `Each fact was checked against its source: ${checked - wrongFacts} of ${checked} match.`}
            {remarks.length > 0 ? ` The check also found ${remarks.length === 1 ? "one thing" : `${remarks.length} things`} to know before you approve:` : ""}</p>
          {remarks.length > 0 && <ul className="verifier-remarks">{remarks.map((note, index) => <li key={index}>{note.note}</li>)}</ul>}
        </div>
      })()}
    </section>}

    {fromMonitor && <p className="note">Built by the Monitor: a rule in code noticed it and wrote this card from the records. No model was used.</p>}
    {card.run && <p className="note run-line">
      <Link className="run-link" href={`/agents/${card.runId}`} title={`${card.run.steps} steps with ${modelWords(card.run.model)}${card.run.escalation ? " (moved up from Sonnet)" : ""}, model cost $${card.run.costUsd.toFixed(2)}`}>See every step the agent took ({card.run.steps})</Link>
    </p>}
  </article>
}
