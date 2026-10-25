"use client"

import Link from "next/link"
import { useState } from "react"
import type { QueueItem } from "@/lib/queue"
import { optionWords, type StepZones } from "@/lib/present/steps"
import type { CardOption, CardStep } from "@/lib/schema"
import { zoneShort } from "@/lib/time"
import { Icon } from "./icons"
import { SourceChip } from "./when"

/** A decision in its undo window. `reference` names the order, so two quick approvals never share one anonymous toast. */
export type Decided = { decisionId: string; cardId: string; message: string; executesAt?: string | null; reference?: string }

const orderHref = (reference: string) => `/orders/${reference}`
const entryHref = (reference: string, entryId: string) => `/orders/${reference}#${entryId}`

/** "Opus, the larger model": the model family, for the quiet line under an agent card. */
function modelWords(model: string | null): string {
  if (!model) return "a model"
  return model.includes("opus") ? "Opus, the larger model" : model.includes("sonnet") ? "Sonnet" : model.includes("haiku") ? "Haiku, the small model" : "a model"
}

/** "it changes a booking and is a booking and a cost and changes a date" → "it books or changes a booking, adds a cost and changes a date". */
function approvalWords(reason: string): string {
  const parts = [
    /contacts a customer/.test(reason) ? "contacts a customer" : null,
    /booking/.test(reason) ? "books or changes a booking" : null,
    /cost/.test(reason) ? "adds a cost" : null,
    /promised/.test(reason) ? "changes a date the customer was promised" : /date/.test(reason) ? "changes a date" : null,
    /call/.test(reason) ? "hands a call to you" : null,
  ].filter((part): part is string => !!part)
  if (!parts.length) return reason
  return `it ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`}`
}

/** "BMW M4: car not at…" and "Volvo V60: Delivered…" read the same way: a capital after the car. */
function headlineWords(headline: string): string {
  return headline.replace(/^([^:]{2,60}: )(\p{Ll})/u, (_, car: string, first: string) => `${car}${first.toUpperCase()}`)
}

/** A button names what it does: an answer to the agent's question says so, and every other approval starts with "Approve:". */
function buttonLabel(option: CardOption): string {
  if (/^(approve|reject|answer)\b/i.test(option.label)) return option.label
  return option.kind === "answer" ? `Answer: ${option.label}` : option.kind === "reject" ? option.label : `Approve: ${option.label}`
}

/** What a person must read before approving: the exact words that go to a customer or a driver. */
function Words({ step, customer }: { step: CardStep; customer: string }) {
  const text = typeof step.params.text === "string" ? step.params.text : null
  if (!text) return null
  // The agent's "to" can carry a description in brackets; the heading needs only who.
  const rawTo = typeof step.params.to === "string" && step.params.to ? step.params.to.replace(/\s*\(.*\)\s*$/, "") : customer
  const to = rawTo.replace(/^The /, "the ")
  const title = step.action === "message_customer" ? `Email to ${to}, sent only if you approve`
    : step.action === "call_customer" || step.action === "call_contact" ? `For the call to ${to}: what to ask`
    : step.action === "message_driver" ? "Message to the driver"
    : null
  if (!title) return null
  const call = step.action === "call_customer" || step.action === "call_contact"
  return <div className="words">
    <div className="words-title">{title}{call && <span className="h3-note">no phone numbers in this demo&apos;s records</span>}</div>
    <p>{text}</p>
  </div>
}

function OptionDetail({ option, customer, zones }: { option: CardOption; customer: string; zones: StepZones }) {
  const words = optionWords(option, zones, true)
  return <>
    {option.effect_text && <p>{option.effect_text}</p>}
    {words && <p className="if-approve"><b>{option.kind === "answer" ? "If you choose it: " : "If you approve: "}</b>{words}.</p>}
    {(option.steps ?? []).map((step, index) => <Words key={index} step={step} customer={customer} />)}
  </>
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
  const { card, order, urgency } = item
  const customer = order.customer
  const tone = urgency.safety ? "safety" : urgency.timeRisk ? "time" : ""
  const fromAgent = !!card.runId
  // Built by a Monitor rule in code (a driver cancelled a gig): a proposal, but no agent waits for a reply.
  const fromMonitor = card.origin === "monitor"
  const proposalSource = card.proposal?.params as { source_entry_id?: string; source_label?: string; source_at?: string } | undefined
  const primary = fromAgent ? card.options.find((option) => option.kind !== "reject") ?? null : null
  const others = fromAgent ? card.options.filter((option) => option !== primary && option.kind !== "reject") : []
  const notes = card.verifierNotes ?? []
  const failing = notes.filter((note) => !note.ok)
  const checked = notes.filter((note) => note.finding != null).length

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
      onDecided({ decisionId: result.decisionId, cardId: card.id, message: result.message ?? `${label}.`, executesAt: result.executesAt ?? null, reference: card.group ? `${card.group.length} orders` : order.reference })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The decision was not saved.")
      setBusy(null)
    }
  }

  // Collapsed, the line says exactly what the button does, built by code from the option's steps.
  const question = card.kind === "question"
  const approveLine = fromAgent && primary ? optionWords(primary, order.zones) : null
  const proposalLine = question ? "pick the answer that is right; the agent carries on from it, nothing is booked or sent"
    : approveLine ?? (fromAgent && primary ? primary.effect_text ?? primary.label : card.proposal?.effect_text)
  const lead = question ? "Agent asks you: " : approveLine ? "If you approve: " : fromMonitor ? "Proposed by code: " : fromAgent ? "Agent proposes: " : "Next step noted: "
  const timesIn = order.zone ? zoneShort(now, order.zone) : null

  return <article className="row" data-open={open} aria-label={card.headline}>
    {!onOrderPage && <button type="button" className="row-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className={`mark ${tone}`} aria-hidden="true" />
      <span className="row-main">
        <span className="row-top">
          <span className="row-title">{headlineWords(card.headline)}</span>
          {urgency.safety && <span className="tag safety">Safety</span>}
          {!onOrderPage && <span className="row-ref">{card.group ? `${card.group.length} orders` : order.reference}</span>}
        </span>
        <span className="row-consequence">
          {urgency.sentence}
          {urgency.relative && <span className={`when rel ${tone}`}>· {urgency.relative}</span>}
        </span>
        {proposalLine && !open && <span className={`row-proposal${approveLine || question ? " full" : ""}`}>
          <b>{lead}</b>{proposalLine}{approveLine || question ? "." : ""}
        </span>}
      </span>
      <Icon name="chevron" size={14} className="row-chevron" />
    </button>}

    {open && <div className="detail">
      <section>
        <h3>What happened</h3>
        <p>{card.whatHappened}</p>
      </section>
      {card.group && <section>
        <h3>{card.group.length} orders, one cause</h3>
        <ul className="group-list">
          {card.group.map((member) => <li key={member.order_id}>
            <Link className="group-order" href={orderHref(member.reference)}>{member.reference} · {member.car}</Link>
            <span>{member.effect}</span>
          </li>)}
        </ul>
      </section>}
      {card.findings.length > 0 && <section>
        <h3>What we know{timesIn && <span className="h3-note">times {timesIn}</span>}</h3>
        <ul className="findings">
          {card.findings.map((finding, index) => {
            const note = failing.find((candidate) => candidate.finding === index)
            return <li className="finding" key={`${finding.source_entry_id}-${index}`}>
              <span className="finding-text">{finding.text}{note && <span className="finding-note">Not confirmed by the verifier: {note.note}</span>}</span>
              <span className="chips">
                <SourceChip label={`${finding.reference ? `${finding.reference} · ` : ""}${finding.source_label}`} at={finding.at} now={now} zone={order.zone} href={entryHref(finding.reference ?? order.reference, finding.source_entry_id)} />
                {finding.also && <SourceChip label={finding.also.source_label} at={finding.also.at} now={now} zone={order.zone} href={entryHref(finding.reference ?? order.reference, finding.also.source_entry_id)} />}
              </span>
            </li>
          })}
        </ul>
        {fromAgent && notes.length > 0 && (() => {
          const wrongFacts = failing.filter((note) => note.finding != null).length
          const remarks = failing.filter((note) => note.finding == null)
          return <div className="note verifier">
            <p>{wrongFacts === 0 ? `A second agent checked all ${checked} facts against their sources: they match.` : `A second agent checked the facts against their sources: ${checked - wrongFacts} of ${checked} match.`}
              {remarks.length > 0 ? ` It also noted ${remarks.length === 1 ? "one thing" : `${remarks.length} things`} the card leaves out or words loosely:` : ""}</p>
            {remarks.length > 0 && <ul className="verifier-remarks">{remarks.map((note, index) => <li key={index}>{note.note}</li>)}</ul>}
          </div>
        })()}
      </section>}
      {fromAgent && primary && <section>
        <h3>{fromMonitor ? "Proposed by code" : card.kind === "question" ? "Agent asks you" : "Agent proposes"}</h3>
        <div className="proposal">
          <OptionDetail option={primary} customer={customer} zones={order.zones} />
          {(card.proposal?.cost_eur || card.proposal?.requires_approval_reason) && <p className="note">
            {card.proposal?.cost_eur ? `New cost about €${Math.round(card.proposal.cost_eur)}. ` : ""}
            {card.proposal?.requires_approval_reason ? `Needs your approval: ${approvalWords(card.proposal.requires_approval_reason)}.` : ""}
          </p>}
        </div>
        {others.map((option) => <div className="other-option" key={option.id}>
          <div className="other-label">Or: {option.label.replace(/^approve:\s*/i, "")}</div>
          <OptionDetail option={option} customer={customer} zones={order.zones} />
        </div>)}
      </section>}
      {!fromAgent && card.proposal && <section>
        <h3>Next step already noted</h3>
        <div className="next-step">
          {card.proposal.effect_text}
          {proposalSource?.source_label && <SourceChip label={proposalSource.source_label} at={proposalSource.source_at ?? null} now={now} zone={order.zone}
            href={proposalSource.source_entry_id ? entryHref(order.reference, proposalSource.source_entry_id) : null} />}
        </div>
      </section>}
      {!fromAgent && <p className="note">Built by code from the alert and the order&apos;s records. No agent has worked on it yet.</p>}
    </div>}

    {/* A code-built card holds no decision, so its buttons wait until the card is opened. */}
    {(open || fromAgent) && <div className="row-actions">
      {/* Collapsed, an agent card shows only its proposal; the other choices wait until the card is opened. */}
      {card.options.filter((option) => open || option === primary).map((option) => {
        const isPrimary = fromAgent && option === primary
        return <button
          key={option.id} type="button" className={`btn small${isPrimary ? " primary" : ""}`} disabled={!!busy}
          onClick={() => decide(option.id, option.label)}
        >{busy === option.id ? "Saving…" : buttonLabel(option)}</button>
      })}
      {!open && fromAgent && card.options.length > 1 && <button type="button" className="btn small" onClick={() => setOpen(true)}>
        {others.length ? "Other choices…" : fromMonitor ? "Reject…" : "Reject or reply…"}
      </button>}
      {!onOrderPage && <Link className="btn small quiet" href={orderHref(order.reference)}>Open order<Icon name="arrow" size={14} /></Link>}
      {error && <span className="note failed-note" role="alert">{error}</span>}
    </div>}
    {fromMonitor && open && <p className="note row-reply">Built by the Monitor: a rule in code noticed it and wrote this card from the records. No model was used.</p>}
    {fromAgent && !fromMonitor && open && <div className="row-reply">
      <form className="reply" onSubmit={(event) => { event.preventDefault(); if (reply.trim()) decide("reply", "Reply sent to the agent", reply.trim()) }}>
        <input value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Or tell the agent what to do instead" aria-label="Reply to the agent" />
        <button type="submit" className="btn small" disabled={!reply.trim() || !!busy}>Send to agent</button>
      </form>
      {card.run && <p className="note run-line">
        <Link className="run-link" href={`/agents/${card.runId}`}>See what the agent did</Link>: {card.run.steps} steps with {modelWords(card.run.model)}{card.run.escalation ? <span title={card.run.escalation}> (moved up from Sonnet)</span> : null}, model cost ${card.run.costUsd.toFixed(2)}
      </p>}
    </div>}
  </article>
}
