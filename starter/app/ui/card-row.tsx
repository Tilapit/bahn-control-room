"use client"

import Link from "next/link"
import { useState } from "react"
import type { QueueItem } from "@/lib/queue"
import type { CardOption, CardStep } from "@/lib/schema"
import { Icon } from "./icons"
import { SourceChip } from "./when"

export type Decided = { decisionId: string; cardId: string; message: string; executesAt?: string | null }

const orderHref = (reference: string) => `/orders/${reference}`
const entryHref = (reference: string, entryId: string) => `/orders/${reference}#${entryId}`

/** "Opus", "Sonnet": the model family, for the quiet line under an agent card. */
function modelWord(model: string | null): string {
  if (!model) return "Agent"
  return model.includes("opus") ? "Opus" : model.includes("sonnet") ? "Sonnet" : model.includes("haiku") ? "Haiku" : "Model"
}

function tokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k tokens` : `${n} tokens`
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
  return <div className="words">
    <div className="words-title">{title}</div>
    <p>{text}</p>
  </div>
}

function OptionDetail({ option, customer }: { option: CardOption; customer: string }) {
  return <>
    {option.effect_text && <p>{option.effect_text}</p>}
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
      onDecided({ decisionId: result.decisionId, cardId: card.id, message: result.message ?? `${label}.`, executesAt: result.executesAt ?? null })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The decision was not saved.")
      setBusy(null)
    }
  }

  // Collapsed, the row's button already names the action; the line says what it does.
  const proposalLine = fromAgent && primary ? primary.effect_text ?? primary.label : card.proposal?.effect_text

  return <article className="row" data-open={open} aria-label={card.headline}>
    {!onOrderPage && <button type="button" className="row-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className={`mark ${tone}`} aria-hidden="true" />
      <span className="row-main">
        <span className="row-top">
          <span className="row-title">{card.headline}</span>
          {urgency.safety && <span className="tag safety">Safety</span>}
          {!onOrderPage && <span className="row-ref">{order.reference}</span>}
        </span>
        <span className="row-consequence">
          {urgency.sentence}
          {urgency.relative && <span className={`when rel ${tone}`}>· {urgency.relative}</span>}
        </span>
        {proposalLine && !open && <span className="row-proposal">
          <b>{fromAgent ? (card.kind === "question" ? "Agent asks: " : "Agent proposes: ") : "Next step noted: "}</b>{proposalLine}
        </span>}
      </span>
    </button>}

    {open && <div className="detail">
      <section>
        <h3>What happened</h3>
        <p>{card.whatHappened}</p>
      </section>
      {card.findings.length > 0 && <section>
        <h3>What we know</h3>
        <ul className="findings">
          {card.findings.map((finding, index) => {
            const note = failing.find((candidate) => candidate.finding === index)
            return <li className="finding" key={`${finding.source_entry_id}-${index}`}>
              <span className="finding-text">{finding.text}{note && <span className="finding-note">Not confirmed by the verifier: {note.note}</span>}</span>
              <span className="chips">
                <SourceChip label={finding.source_label} at={finding.at} now={now} zone={order.zone} href={entryHref(order.reference, finding.source_entry_id)} />
                {finding.also && <SourceChip label={finding.also.source_label} at={finding.also.at} now={now} zone={order.zone} href={entryHref(order.reference, finding.also.source_entry_id)} />}
              </span>
            </li>
          })}
        </ul>
        {fromAgent && notes.length > 0 && <p className="note verifier">
          {failing.length === 0
            ? `Checked by the verifier: all ${checked} facts match their sources.`
            : `Checked by the verifier: ${checked - failing.filter((note) => note.finding != null).length} of ${checked} facts match their sources.`}
          {failing.filter((note) => note.finding == null).map((note, index) => <span key={index} className="verifier-card-note">Verifier: {note.note}</span>)}
        </p>}
      </section>}
      {fromAgent && primary && <section>
        <h3>{card.kind === "question" ? "Agent asks you" : "Agent proposes"}</h3>
        <div className="proposal">
          <OptionDetail option={primary} customer={customer} />
          {(card.proposal?.cost_eur || card.proposal?.requires_approval_reason) && <p className="note">
            {card.proposal?.cost_eur ? `New cost about €${Math.round(card.proposal.cost_eur)}. ` : ""}
            {card.proposal?.requires_approval_reason ? `Needs your approval: ${card.proposal.requires_approval_reason}.` : ""}
          </p>}
        </div>
        {others.map((option) => <div className="other-option" key={option.id}>
          <div className="other-label">Or: {option.label}</div>
          <OptionDetail option={option} customer={customer} />
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
        >{busy === option.id ? "Saving…" : option.label}</button>
      })}
      {!open && fromAgent && card.options.length > 1 && <button type="button" className="btn small quiet" onClick={() => setOpen(true)}>
        {card.options.length - 1} more choice{card.options.length - 1 === 1 ? "" : "s"}
      </button>}
      {!onOrderPage && <Link className="btn small quiet" href={orderHref(order.reference)}>Open order<Icon name="arrow" size={14} /></Link>}
      {error && <span className="note" role="alert" style={{ color: "var(--red)" }}>{error}</span>}
    </div>}
    {fromAgent && open && <div className="row-reply">
      <form className="reply" onSubmit={(event) => { event.preventDefault(); if (reply.trim()) decide("reply", "Reply sent to the agent", reply.trim()) }}>
        <input value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Or tell the agent what to do instead" aria-label="Reply to the agent" />
        <button type="submit" className="btn small" disabled={!reply.trim() || !!busy}>Send to agent</button>
      </form>
      {card.run && <p className="note run-line">
        Investigated by the agent · {modelWord(card.run.model)} · {card.run.steps} steps · {tokens(card.run.tokens)} · ${card.run.costUsd.toFixed(2)}
        {card.run.escalation ? <span title={card.run.escalation}> · moved to the senior model</span> : null}
      </p>}
    </div>}
  </article>
}
