"use client"

import Link from "next/link"
import { useState } from "react"
import type { QueueItem } from "@/lib/queue"
import { Icon } from "./icons"
import { SourceChip } from "./when"

export type Decided = { decisionId: string; cardId: string; message: string }

const orderHref = (reference: string) => `/orders/${reference}`
const entryHref = (reference: string, entryId: string) => `/orders/${reference}#${entryId}`

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
  const tone = urgency.safety ? "safety" : urgency.timeRisk ? "time" : ""
  const fromAgent = !!card.runId
  const proposalSource = card.proposal?.params as { source_entry_id?: string; source_label?: string; source_at?: string } | undefined

  async function decide(optionId: string, label: string, replyText?: string) {
    setBusy(optionId)
    setError(null)
    try {
      const response = await fetch(`/api/cards/${encodeURIComponent(card.id)}/decision`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionId, replyText: replyText ?? null }),
      })
      const result = await response.json() as { decisionId?: string; message?: string; error?: string }
      if (!response.ok || !result.decisionId) throw new Error(result.error ?? "The decision was not saved.")
      onDecided({ decisionId: result.decisionId, cardId: card.id, message: result.message ?? `${label}.` })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The decision was not saved.")
      setBusy(null)
    }
  }

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
        {card.proposal && !open && <span className="row-proposal">
          <b>{fromAgent ? "Agent proposes: " : "Next step noted: "}</b>{card.proposal.effect_text}
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
          {card.findings.map((finding, index) => <li className="finding" key={`${finding.source_entry_id}-${index}`}>
            <span className="finding-text">{finding.text}</span>
            <SourceChip label={finding.source_label} at={finding.at} now={now} zone={order.zone} href={entryHref(order.reference, finding.source_entry_id)} />
          </li>)}
        </ul>
      </section>}
      {card.proposal && <section>
        <h3>{fromAgent ? "Agent proposes" : "Next step already noted"}</h3>
        <div className="next-step">
          {card.proposal.effect_text}
          {proposalSource?.source_label && <SourceChip label={proposalSource.source_label} at={proposalSource.source_at ?? null} now={now} zone={order.zone}
            href={proposalSource.source_entry_id ? entryHref(order.reference, proposalSource.source_entry_id) : null} />}
        </div>
        {card.proposal.requires_approval_reason && <p className="note" style={{ marginTop: 6 }}>Needs your approval: {card.proposal.requires_approval_reason}</p>}
      </section>}
      {!fromAgent && <p className="note">Built by code from the alert and the order&apos;s records. No agent has worked on it yet.</p>}
    </div>}

    {/* A code-built card holds no decision, so its buttons wait until the card is opened. */}
    {(open || fromAgent) && <div className="row-actions">
      {card.options.map((option, index) => <button
        key={option.id} type="button" className={`btn small${index === 0 && fromAgent ? " primary" : ""}`} disabled={!!busy}
        onClick={() => decide(option.id, option.label)}
      >{busy === option.id ? "Saving…" : option.label}</button>)}
      {fromAgent && open && <form className="reply" onSubmit={(event) => { event.preventDefault(); if (reply.trim()) decide("reply", "Reply sent to the agent", reply.trim()) }}>
        <input value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Tell the agent what to do instead" aria-label="Reply to the agent" />
        <button type="submit" className="btn small" disabled={!reply.trim() || !!busy}>Send to agent</button>
      </form>}
      {!onOrderPage && <Link className="btn small quiet" href={orderHref(order.reference)}>Open order<Icon name="arrow" size={14} /></Link>}
      {error && <span className="note" role="alert" style={{ color: "var(--red)" }}>{error}</span>}
    </div>}
  </article>
}
