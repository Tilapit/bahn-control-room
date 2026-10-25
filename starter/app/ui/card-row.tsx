"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import type { QueueItem } from "@/lib/queue"
import { sourceKind } from "@/lib/sources"
import { problemPhrase } from "@/lib/status"
import { optionWords, stepList, type StepZones } from "@/lib/present/steps"
import type { CardOption, CardStep } from "@/lib/schema"
import { clock, clockZone, long, relative, zoneShort } from "@/lib/time"
import { DecisionReason, EMPTY_REASON, type ReasonValue } from "./decision-reason"
import { SimilarCases } from "./similar-cases"
import { Icon } from "./icons"
import { TakenOverBar, TakeOverButton } from "./takeover"
import { CrossBorder, useTeamView } from "./view-switcher"
import { COLLEAGUES, initialsOf, isStale, quietMinutes, YOU } from "@/lib/people"
import { inView, passesThrough } from "@/lib/teams"
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
  // A reject never says "I'll handle it": that is what the take-over button does, and the two read alike.
  if (/^reject\b/i.test(option.label)) return option.label.replace(/[,;]\s*I[’']ll handle it\.?$/i, "")
  if (/^(approve|answer)\b/i.test(option.label)) return option.label
  // "Move ferry …" reads "Approve: move ferry …"; an acronym ("CMR …") keeps its capitals.
  const rest = /^\p{Lu}\p{Ll}/u.test(option.label) ? option.label.charAt(0).toLowerCase() + option.label.slice(1) : option.label
  return option.kind === "answer" ? `Answer: ${rest}` : option.kind === "reject" ? option.label.replace(/[,;]\s*I[’']ll handle it\.?$/i, "") : `Approve: ${rest}`
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
  const primary = card.runId || card.origin === "monitor" ? card.options.find((option) => option.kind !== "reject") ?? null : null
  if (primary) return primary.label.replace(/^approve:\s*/i, "")
  return card.proposal?.effect_text ? `Next step noted: ${card.proposal.effect_text}` : "Built from an alert; no agent has worked on it yet"
}

/** "Stopped on red warning": the problem with a capital, for a card's title. */
const titleCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Who has the order: you, a colleague (gone quiet after 30 simulated minutes with no action), or nobody. */
export function claimOf(item: QueueItem, now: string): { kind: "you" | "colleague" | "stale" | "none"; who: string | null; minutes: number } {
  const claim = item.takenOver
  if (!claim) return { kind: "none", who: null, minutes: 0 }
  if (claim.by === YOU) return { kind: "you", who: "You", minutes: 0 }
  const at = new Date(now)
  return { kind: isStale(claim, at) ? "stale" : "colleague", who: claim.by, minutes: quietMinutes(claim, at) }
}

function ClaimLine({ item, now }: { item: QueueItem; now: string }) {
  const claim = claimOf(item, now)
  if (claim.kind === "none") return <span className="claim"><span className="avatar none" aria-hidden="true" />Unclaimed</span>
  if (claim.kind === "you") return <span className="claim you"><span className="avatar green" aria-hidden="true">Y</span>You have this</span>
  const avatar = <span className={`avatar ${COLLEAGUES.find((colleague) => colleague.name === claim.who)?.tone ?? ""}`} aria-hidden="true">{initialsOf(claim.who!)}</span>
  return claim.kind === "stale"
    ? <span className="claim stale">{avatar}{claim.who} · no activity {claim.minutes} min</span>
    : <span className="claim">{avatar}{claim.who} is on it</span>
}

/**
 * One order in the For you list, as a card: its desk and reference with the time left, the problem in a few words,
 * the car and route, and who has it. No buttons: the selected order opens on the right.
 */
export function CaseListRow({ item, now, selected, onSelect }: { item: QueueItem; now: string; selected: boolean; onSelect: () => void }) {
  const { card, order, urgency } = item
  const tone = urgency.safety ? "safety" : urgency.timeRisk ? "time" : ""
  const missed = !!urgency.at && urgency.relative.endsWith("ago")
  const when = missed ? `missed ${urgency.relative.replace(/ ago$/, "")} ago` : urgency.relative.replace(/^in /, "")
  const [view] = useTeamView()
  const through = passesThrough(item.team, view)
  const foreign = !inView(item.team, view)
  const problem = problemPhrase(card.headline) ?? card.headline
  return <li className="inbox-row" data-selected={selected} data-card={card.id}>
    <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined} title={card.headline}>
      <span className="fy-card-top">
        <span className={`tag desk${urgency.safety ? " safety" : ""}`}>{card.group ? `${card.group.length} orders` : item.team.desk ?? "Ops"}</span>
        <span className="row-ref">{card.group ? "" : order.reference}</span>
        {foreign && <span className="tag cross">{item.team.market === "Other" ? "Other country" : item.team.market}</span>}
        {through && <CrossBorder team={item.team} />}
        <span className={`when ${tone}`}>{when || "no deadline"}</span>
      </span>
      <span className="fy-card-title">{clip(titleCase(problem), 64)}</span>
      <span className="fy-card-car">{card.group ? card.group.map((member) => member.reference).join(", ") : `${order.car} · ${order.route}`}</span>
      <ClaimLine item={item} now={now} />
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
  // An agent's proposal, or one a rule in code wrote (a cancelled gig, a backup who accepted): both need a yes.
  const proposes = fromAgent || fromMonitor
  const proposalSource = card.proposal?.params as { source_entry_id?: string; source_label?: string; source_at?: string } | undefined
  const primary = proposes ? card.options.find((option) => option.kind !== "reject") ?? null : null
  const others = proposes ? card.options.filter((option) => option !== primary && option.kind !== "reject") : []
  const rejects = card.options.filter((option) => option.kind === "reject")
  const notes = card.verifierNotes ?? []
  const failing = notes.filter((note) => !note.ok)
  const checked = notes.filter((note) => note.finding != null).length
  const question = card.kind === "question"

  const claim = claimOf(item, now)
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
      <div className="cd-top">
        <span className={`tag desk${urgency.safety ? " safety" : ""}`}>{card.group ? `${card.group.length} orders` : item.team.desk ?? "Ops"}</span>
        {!card.group && <Link className="cd-ref" href={orderHref(order.reference)} title="Open the order">{order.reference}</Link>}
      </div>
      <h2>{titleCase(problemPhrase(card.headline) ?? card.headline)}</h2>
      <p className="cd-due"><span>Due</span><b className={`when ${tone}`}>{urgency.relative ? (urgency.relative.endsWith("ago") ? `missed ${urgency.relative}` : urgency.relative) : "no deadline"}</b></p>
    </header>}

    {!onOrderPage && !card.group && <div className={`claim-banner ${claim.kind}`}>
      {claim.kind === "none" && <><span className="avatar none" aria-hidden="true" /><p><b>Nobody has this yet.</b> Take it, and agents leave the order to you until you hand it back.</p></>}
      {claim.kind === "colleague" && <><span className={`avatar ${COLLEAGUES.find((colleague) => colleague.name === claim.who)?.tone ?? ""}`} aria-hidden="true">{initialsOf(claim.who!)}</span><p><b>{claim.who} is on it</b>, since {clockZone(item.takenOver!.at, order.zone)}.</p></>}
      {claim.kind === "stale" && <><span className={`avatar ${COLLEAGUES.find((colleague) => colleague.name === claim.who)?.tone ?? ""}`} aria-hidden="true">{initialsOf(claim.who!)}</span><p><b>{claim.who} claimed this {Math.round((new Date(now).getTime() - new Date(item.takenOver!.at).getTime()) / 60_000)} min ago</b> — no activity since. Free to pick up.</p></>}
      {claim.kind !== "you" && <span className="key-wrap" data-key-host={keys ? "t" : undefined}><TakeOverButton reference={order.reference} className={`btn${claim.kind === "stale" ? " amber" : ""}`} label={claim.kind === "none" ? "Take this" : "Take over"} from={claim.kind === "none" ? null : claim.who} hint={keys ? <Key k="T" /> : null} /></span>}
      {claim.kind === "you" && <TakenOverBar reference={order.reference} since={item.takenOver!.at} by={item.takenOver!.by} zone={order.zone} />}
    </div>}

    {!onOrderPage && !card.group && <dl className="cd-crd">
      <div><dt>Car</dt><dd>{order.car}</dd></div>
      <div><dt>Route</dt><dd>{order.route}{item.team.crossBorder && <> <CrossBorder team={item.team} /></>}</dd></div>
      <div><dt>Driver</dt><dd>{order.driver ?? "Not booked yet"}</dd></div>
      <div><dt>Customer</dt><dd>{customer}</dd></div>
    </dl>}

    {!onOrderPage && !card.group && item.journey.length > 1 && <section className="journey" aria-label="The car's journey">
      <div className="journey-head"><h3>The car&apos;s journey</h3><span className="journey-legend"><i className="ms done" />Confirmed<i className="ms problem" />Problem<i className="ms planned" />Planned</span></div>
      <ol>
        {item.journey.map((stop, index) => <li key={index} className={stop.state}>
          <i className={`ms ${stop.state}`} aria-hidden="true" />
          <b>{stop.label}</b>
          {stop.at && <time dateTime={stop.at}>{factTime(stop.at, now, stop.zone)}</time>}
          <span>{stop.note}</span>
        </li>)}
      </ol>
    </section>}

    <section className="cd-what">
      <h3>What happened</h3>
      <p className="summary">{firstSentence(card.whatHappened)}</p>
      {!onOrderPage && <p className={`cd-when when ${tone}`}>{urgency.sentence}</p>}
    </section>

    {card.group && <ul className="group-list">
      {card.group.map((member) => <li key={member.order_id}>
        <Link className="group-order" href={orderHref(member.reference)}>{member.reference} · {member.car}</Link>
        <span>{member.effect}</span>
      </li>)}
    </ul>}

    {card.findings.length > 0 && <section className="cd-facts">
      <h3>What we know<span className="h3-note">most important first{timesIn ? ` · times ${timesIn}` : ""}</span></h3>
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

    {card.run && card.run.did.length > 0 && <section className="agent-did">
      <h3>What the agent already did</h3>
      <ul>{card.run.did.map((text, index) => <li key={index}><Icon name="check" size={14} />{text}</li>)}</ul>
    </section>}

    {proposes && primary && !question && <div className="suggests">
      <p className="suggests-label"><Icon name="bot" size={14} />{fromMonitor ? "A rule in code suggests" : "Agent suggests"}</p>
      <p className="suggests-text">{titleCase(primary.label.replace(/^approve:\s*/i, ""))}.</p>
    </div>}

    {proposes && primary && <div className="approve-box">
      <h3>{question ? "Agent asks you" : fromMonitor ? "If you approve (proposed by code)" : "If you approve"}</h3>
      {question ? <p>Pick the answer that is right; the agent carries on from it. Nothing is booked or sent.</p> : <Effects option={primary} zones={order.zones} />}
      {!question && (card.proposal?.cost_eur || card.proposal?.requires_approval_reason) && <p className="note">
        {card.proposal?.cost_eur ? `New cost about €${Math.round(card.proposal.cost_eur)}. ` : ""}
        {card.proposal?.requires_approval_reason ? `Needs your approval because ${approvalWords(primary, card.proposal.requires_approval_reason)}.` : ""}
        {steps.some((step) => step.action === "call_customer" || step.action === "call_contact") ? " Approving does not dial anyone: the call is yours, with the script below; the rest happens when you approve." : ""}
      </p>}
      {steps.map((step, index) => <Words key={index} step={step} customer={customer} />)}
    </div>}
    {!proposes && card.proposal && <div className="approve-box">
      <h3>Next step already noted</h3>
      <p>{card.proposal.effect_text} {proposalSource?.source_label && <SourceChip label={proposalSource.source_label} at={proposalSource.source_at ?? null} now={now} zone={order.zone}
        href={proposalSource.source_entry_id ? entryHref(order.reference, proposalSource.source_entry_id) : null} />}</p>
      <p className="note">Built by code from the alert and the order&apos;s records. No agent has worked on it yet.</p>
    </div>}

    <div className="row-actions">
      {buttons.map((option, index) => <button
        key={option.id} type="button" className={`btn${proposes ? " primary" : ""}`} disabled={!!busy}
        data-key={keys && proposes && !question && index === 0 ? "a" : undefined}
        onClick={() => decide(option.id, option.label)}>{busy === option.id ? "Saving…" : buttonLabel(option)}{keys && proposes && !question && index === 0 && <Key k="A" />}</button>)}
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
    {proposes && <SimilarCases cardId={card.id} />}


    {fromMonitor && <p className="note">Built by the Monitor: a rule in code noticed it and wrote this card from the records. No model was used.</p>}
    {card.run && <p className="note run-line">
      <Link className="run-link" href={`/agents/${card.runId}`} title={`${card.run.steps} steps with ${modelWords(card.run.model)}${card.run.escalation ? " (moved up from Sonnet)" : ""}, model cost $${card.run.costUsd.toFixed(2)}`}>See every step the agent took ({card.run.steps})</Link>
    </p>}
  </article>
}
