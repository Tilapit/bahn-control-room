"use client"

import Link from "next/link"
import { useState } from "react"
import type { QueueItem } from "@/lib/queue"
import { sourceKind } from "@/lib/sources"
import { problemPhrase } from "@/lib/status"
import { optionWords, stepList, type StepZones } from "@/lib/present/steps"
import type { CardOption, CardStep } from "@/lib/schema"
import { clock, long, relative, zoneShort } from "@/lib/time"
import { Icon } from "./icons"
import { TakenOverBar, TakeOverButton } from "./takeover"
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

/** "BMW M4 · ferry sold out": the car and the problem, at most about 50 characters, built by code from the headline. */
function shortHeadline(car: string, headline: string, group: number | null): string {
  const problem = problemPhrase(headline) ?? headline
  const text = `${group ? `${group} orders` : car} · ${problem}`
  return text.length > 52 ? `${text.slice(0, 50).replace(/[\s,;:·-]+\S*$/, "")}…` : text
}

/** "11:14" today, "Mon 15:37" on another day: the left column of What we know, in the order's zone. */
function factTime(at: string, now: string, zone: string | null): string {
  const day = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value))
  return day(at) === day(now) ? clock(at, zone) : `${new Intl.DateTimeFormat("en-GB", { timeZone: zone ?? "UTC", weekday: "short" }).format(new Date(at))} ${clock(at, zone)}`
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

export function CardRow({ item, now, open: startOpen = false, onOrderPage = false, onDecided }: {
  item: QueueItem
  now: string
  open?: boolean
  /** On the order page the header already says what is wrong and when; the card shows only its body. */
  onOrderPage?: boolean
  onDecided: (decided: Decided) => void
}) {
  const [open, setOpen] = useState(startOpen || onOrderPage)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState("")
  const [answering, setAnswering] = useState(false)
  const [fullFact, setFullFact] = useState<number | null>(null)
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

  async function decide(optionId: string, label: string, replyText?: string) {
    setBusy(optionId)
    setError(null)
    try {
      const response = await fetch(`/api/cards/${encodeURIComponent(card.id)}/decision`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionId, replyText: replyText ?? null }),
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

  // The collapsed line: what the primary button does, in the agent's own button words without "Approve:".
  const action = question ? "Agent asks you a question"
    : primary ? primary.label.replace(/^approve:\s*/i, "")
    : card.proposal?.effect_text ? `Next step noted: ${card.proposal.effect_text}` : "Built from an alert; no agent has worked on it yet"
  const timesIn = order.zone ? zoneShort(now, order.zone) : null
  const short = shortHeadline(order.car, card.headline, card.group?.length ?? null)
  const steps = primary?.steps ?? []

  return <article className="row" data-open={open} aria-label={card.headline}>
    {!onOrderPage && <div className="row-line">
      <button type="button" className="row-head" aria-expanded={open} onClick={() => setOpen((value) => !value)} title={card.headline}>
        <span className={`mark ${tone}`} aria-hidden="true" />
        <span className="row-title"><span className="row-title-text">{short}</span>{urgency.safety && <span className="tag safety">Safety</span>}{item.takenOver && <span className="tag yours">Yours</span>}</span>
        <span className="row-when" title={urgency.sentence}>
          {urgency.relative && <span className={`when ${tone}`}>{urgency.relative}</span>}
          <span className="row-sentence">{urgency.sentence}</span>
        </span>
        <span className="row-action">{action}</span>
      </button>
      <span className="row-go">
        {fromAgent && primary && !question && !open
          ? <button type="button" className="btn small primary" disabled={!!busy} title={buttonLabel(primary)} aria-label={buttonLabel(primary)}
            onClick={() => decide(primary.id, primary.label)}>{busy === primary.id ? "Saving…" : "Approve"}</button>
          : <button type="button" className="btn small" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? "Close" : question ? "Answer…" : "Open"}</button>}
      </span>
    </div>}

    {open && <div className="detail">
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
        {(question ? card.options.filter((option) => option.kind !== "reject") : primary ? [primary] : card.options.filter((option) => option.kind !== "reject")).map((option) => <button
          key={option.id} type="button" className={`btn small${fromAgent ? " primary" : ""}`} disabled={!!busy}
          onClick={() => decide(option.id, option.label)}>{busy === option.id ? "Saving…" : buttonLabel(option)}</button>)}
        {!onOrderPage && !item.takenOver && !card.group && <TakeOverButton reference={order.reference} />}
        {(rejects.length > 0 || others.length > 0) && <button type="button" className="btn small" aria-expanded={answering} onClick={() => setAnswering((value) => !value)}>
          {fromAgent && !fromMonitor ? "Reject or reply" : "Reject…"}
        </button>}
        {!onOrderPage && <Link className="btn small quiet" href={orderHref(order.reference)}>Open order<Icon name="arrow" size={14} /></Link>}
        {error && <span className="note failed-note" role="alert">{error}</span>}
      </div>

      {answering && <div className="answer-box">
        {others.map((option) => <div className="other-option" key={option.id}>
          <button type="button" className="btn small" disabled={!!busy} onClick={() => decide(option.id, option.label)}>{busy === option.id ? "Saving…" : buttonLabel(option)}</button>
          <span className="note">If you choose it: {optionWords(option, order.zones) ?? option.effect_text}.</span>
        </div>)}
        <div className="answer-row">
          {rejects.map((option) => <button key={option.id} type="button" className="btn small" disabled={!!busy} onClick={() => decide(option.id, option.label)}>{busy === option.id ? "Saving…" : buttonLabel(option)}</button>)}
        </div>
        {fromAgent && !fromMonitor && <form className="reply" onSubmit={(event) => { event.preventDefault(); if (reply.trim()) decide("reply", "Reply sent to the agent", reply.trim()) }}>
          <input value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Or tell the agent what to do instead" aria-label="Reply to the agent" />
          <button type="submit" className="btn small" disabled={!reply.trim() || !!busy}>Send to agent</button>
        </form>}
      </div>}

      {card.findings.length > 0 && <section>
        <h3>What we know{timesIn && <span className="h3-note">times {timesIn}</span>}</h3>
        <ul className="facts-compact">
          {card.findings.map((finding, index) => {
            const note = failing.find((candidate) => candidate.finding === index)
            const kind = sourceKind(finding.channel)
            const reference = finding.reference ?? order.reference
            return <li key={`${finding.source_entry_id}-${index}`} data-full={fullFact === index}>
              <Link className="fact-src" href={entryHref(reference, finding.source_entry_id)} title={`${finding.reference ? `${finding.reference} · ` : ""}${finding.source_label} · ${long(finding.at, order.zone)} (${relative(finding.at, now)})`}>
                <Icon name={kind.icon} size={13} /><time dateTime={finding.at}>{factTime(finding.at, now, order.zone)}</time>
              </Link>
              <button type="button" className="fact-text" onClick={() => setFullFact((value) => value === index ? null : index)} title={fullFact === index ? undefined : `${finding.text} (${finding.source_label})`}>
                {finding.text}
                {note && <span className="finding-note">Not confirmed by the check: {note.note}</span>}
              </button>
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
    </div>}
  </article>
}
