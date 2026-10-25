"use client"

import { useRouter } from "next/navigation"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import type { QueueItem, YoursWithoutCard } from "@/lib/queue"
import { inView, type TeamView, viewWords } from "@/lib/teams"
import { dayClockZone } from "@/lib/time"
import { CaseDetail, CaseListRow, type Decided } from "./card-row"
import { useDecisionToast } from "./decision-toast"
import { Icon } from "./icons"
import { useTeamView, ViewSwitcher } from "./view-switcher"

/** Now: a person's safety, or something lost within 4 hours or already lost. Everything else waits under Later. */
export const isNow = (item: QueueItem) => item.urgency.safety || item.urgency.timeRisk

/** The desk's own clock for "nothing lost before …": the top bar shows Helsinki time too. */
const DESK = "Europe/Helsinki"

/** Typing in a field, or a shortcut with ⌘/Ctrl/Alt (⌘K is search), is never a For you shortcut. */
function typing(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null
  return event.metaKey || event.ctrlKey || event.altKey || !!target?.closest("input, textarea, select, [contenteditable='true']")
}

/**
 * For you as an inbox (the Apple Mail pattern): the list on the left, the selected case on the right.
 * A decision removes the case at once, the next one is selected, and the toast counts down the undo window.
 * Keyboard: J/K move, Enter opens, A approves, R replies, T takes over. Narrow screens show the list, then the case full width.
 */
export function Queue({ items, now, emptyLine, endLine, yoursWithoutCard = [], initial = null, tail, title = "For you", hint, children }: {
  items: QueueItem[]; now: string; emptyLine: string; endLine?: string; yoursWithoutCard?: YoursWithoutCard[]
  /** The header line after the counts this view decides: "agents are handling 10 · nothing open on 966". */
  tail: string[]
  title?: string
  /** The header line's hover text. */
  hint?: string
  /** Shown under the header (the autonomy suggestion). */
  children?: ReactNode
  /** An order number from the address (?case=CD-420299) to select first. */
  initial?: string | null
}) {
  const router = useRouter()
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [showLater, setShowLater] = useState(() => !!initial && items.some((item) => item.order.reference === initial && !isNow(item) && !item.takenOver))
  const [selectedId, setSelectedId] = useState<string | null>(() => items.find((item) => item.order.reference === initial)?.card.id ?? null)
  // Narrow screens only: the case is open full width instead of the list.
  const [opened, setOpened] = useState(false)
  // The case a person opened (a click, or Enter). A approves only that one: on a case J or K merely moved to, the first
  // A opens it, so one stray key never approves the case that happened to be selected when the page loaded.
  const [activeId, setActiveId] = useState<string | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const toast = useDecisionToast((cardId) => {
    setHidden((set) => { const next = new Set(set); next.delete(cardId); return next })
    setSelectedId(cardId)
  })

  const [view, setView] = useTeamView()
  const visible = items.filter((item) => !hidden.has(item.card.id))
  // Orders a person took over come first, under Yours, whatever the view: they are this person's own.
  const yours = visible.filter((item) => item.takenOver)
  // The view (market and desks) decides what is listed; what it leaves out is counted in one muted row, never hidden
  // silently. A person's safety is listed in every view, with its country.
  const listed = (item: QueueItem) => inView(item.team, view) || item.urgency.safety
  const rest = visible.filter((item) => !item.takenOver && listed(item))
  const outside = visible.filter((item) => !item.takenOver && !listed(item))
  const nowItems = rest.filter(isNow)
  const later = rest.filter((item) => !isNow(item))
  const outsideNow = outside.filter(isNow)
  const where = viewWords(view)
  const elsewhere = otherWords(view)
  const ownNow = nowItems.filter((item) => inView(item.team, view)).length
  const safetyElsewhere = nowItems.length - ownNow
  const line = [
    `${ownNow} need${ownNow === 1 ? "s" : ""} you now${where ? ` ${where}` : ""}`,
    safetyElsewhere ? `+${safetyElsewhere} safety in ${groupWords(nowItems.filter((item) => !inView(item.team, view)), view).replace(/ \d+/g, "")}` : null,
    outsideNow.length ? `${outsideNow.length} more in ${elsewhere}` : null,
    `${later.length} can wait`,
    // What agents handle and what is quiet is counted across every market, so it is said only for everyone.
    ...(where ? [] : tail),
  ].filter(Boolean).join(" · ")
  // The rows J and K move through, in the order they are shown.
  const order = [...yours, ...nowItems, ...(showLater ? later : [])]
  const selected = order.find((item) => item.card.id === selectedId) ?? visible.find((item) => item.card.id === selectedId) ?? order[0] ?? null
  // An alert's response time sorts a card but is no deadline; only real ones count for "nothing lost before".
  const firstLater = later.filter((item) => item.urgency.kind !== "alert_followup").map((item) => item.urgency.at).filter((at): at is string => !!at).sort()[0] ?? null

  function decided(result: Decided) {
    // The next case is the one below; after the last, the one above.
    const index = order.findIndex((item) => item.card.id === result.cardId)
    const next = order[index + 1] ?? order[index - 1] ?? null
    setHidden((set) => new Set(set).add(result.cardId))
    setSelectedId(next?.card.id ?? null)
    setActiveId(null)
    toast.show(result)
    router.refresh()
  }

  const select = useCallback((id: string, open = false) => {
    setSelectedId(id)
    setActiveId(open ? id : null)
    if (open) setOpened(true)
    requestAnimationFrame(() => document.querySelector(`.inbox-row[data-card="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }))
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (typing(event)) return
      const key = event.key.toLowerCase()
      const index = selected ? order.findIndex((item) => item.card.id === selected.card.id) : -1
      if (key === "j" || key === "k") {
        const next = order[key === "j" ? Math.min(order.length - 1, index + 1) : Math.max(0, index - 1)]
        if (next) { event.preventDefault(); select(next.card.id) }
      } else if (key === "enter" && selected && !(event.target as HTMLElement | null)?.closest("button, a")) {
        event.preventDefault()
        setOpened(true)
        setActiveId(selected.card.id)
        detailRef.current?.focus({ preventScroll: true })
      } else if (key === "escape" && opened) {
        setOpened(false)
      } else if ((key === "a" || key === "r" || key === "t") && selected) {
        event.preventDefault()
        if (key === "a" && activeId !== selected.card.id) {
          setActiveId(selected.card.id)
          setOpened(true)
          detailRef.current?.focus({ preventScroll: true })
          return
        }
        const button = detailRef.current?.querySelector<HTMLButtonElement>(`[data-key="${key}"], [data-key-host="${key}"] button`)
        if (button && !button.disabled) button.click()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [order, selected, opened, select, activeId])

  const head = <div className="page-head inbox-head">
    <div>
      <h1>{title}</h1>
      <p className="page-sub" title={hint}>{line}</p>
    </div>
    <ViewSwitcher />
  </div>
  // What the view leaves out of Now, by country (or desk), as one muted row: "3 more in other countries: Germany 2, Denmark 1".
  const outsideRow = outsideNow.length > 0 && <button type="button" className="inbox-outside" onClick={() => setView({ ...view, market: "Everyone", desks: [] })}>
    <span>{outsideNow.length} more in {elsewhere}: {groupWords(outsideNow, view)}</span>
    <span className="inbox-outside-show">Show everyone</span>
  </button>

  if (visible.length === 0 && yoursWithoutCard.length === 0) return <>
    {head}{children}
    <div className="empty"><h2>Nothing needs you right now.</h2><p>{emptyLine}</p></div>
    {toast.view}
  </>

  const row = (item: QueueItem) => <CaseListRow key={item.card.id} item={item} selected={selected?.card.id === item.card.id} onSelect={() => select(item.card.id, true)} />
  return <>{head}{children}<div className="inbox" data-opened={opened}>
    <div className="inbox-list">
      {(yours.length > 0 || yoursWithoutCard.length > 0) && <section aria-label="Yours">
        <h2 className="queue-section">Yours <span className="faint">· agents are paused on these</span></h2>
        <ul className="inbox-rows">
          {yours.map(row)}
          {yoursWithoutCard.map((item) => <li className="inbox-row" key={item.order.id}><Link href={`/orders/${item.order.reference}`}>
            <span className="mark" aria-hidden="true" />
            <span className="inbox-line1"><span className="inbox-title">{item.order.car} · {item.open[0] ?? "nothing open on it now"}</span></span>
            <span className="inbox-line2"><span className="inbox-proposal">No card; the order is yours</span><span className="row-ref">{item.order.reference}</span></span>
          </Link></li>)}
        </ul>
      </section>}
      <section aria-label="Now">
        <h2 className="queue-section">Now <span className="faint">· safety first, then what is due within 4 hours or already missed</span></h2>
        {nowItems.length === 0 ? <p className="note queue-note">Nothing is at risk in the next 4 hours{where ? ` ${where}` : ""}.</p> : <ul className="inbox-rows">{nowItems.map(row)}</ul>}
        {outsideRow}
      </section>
      {later.length > 0 && <section aria-label="Later">
        <button type="button" className="later-toggle" aria-expanded={showLater} onClick={() => setShowLater((value) => !value)}>
          <Icon name="chevron" size={14} className="row-chevron" />
          <b>Later · {later.length}</b>{outside.length - outsideNow.length > 0 && <span className="faint">+{outside.length - outsideNow.length} in {elsewhere}</span>}
          <span>{firstLater ? `nothing due before ${dayClockZone(firstLater, now, DESK)}` : "no deadline in the records"}</span>
        </button>
        {showLater && <ul className="inbox-rows">{later.map(row)}</ul>}
      </section>}
      <p className="inbox-keys" aria-hidden="true"><kbd>J</kbd><kbd>K</kbd> move · <kbd>Enter</kbd> open, then <kbd>A</kbd> approve · <kbd>R</kbd> reject or reply · <kbd>T</kbd> I&apos;ll handle this</p>
      {endLine && <p className="queue-end">{endLine}</p>}
    </div>
    <div className="inbox-detail" ref={detailRef} tabIndex={-1} aria-label="Selected case">
      <button type="button" className="btn quiet inbox-back" onClick={() => setOpened(false)}><Icon name="chevron" size={14} className="back-chevron" />Back to the list</button>
      {selected
        ? <CaseDetail key={selected.card.id} item={selected} now={now} keys onDecided={decided} />
        : <div className="empty"><h2>Nothing needs you now.</h2><p>{later.length ? `${later.length} more can wait under Later.` : emptyLine}</p></div>}
    </div>
    {toast.view}
  </div></>
}

/** "other countries", "other desks": what a view leaves out, in the header and the muted row. */
function otherWords(view: TeamView): string {
  if (view.market !== "Everyone") return view.desks.length ? "other countries or desks" : "other countries"
  return "other desks"
}

/** "Denmark 1, Germany 1": the cases outside the view, by the customer's country, or by desk when only desks filter. */
function groupWords(items: QueueItem[], view: TeamView): string {
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = view.market !== "Everyone" && item.team.market !== view.market ? (item.team.market === "Other" ? "other countries" : item.team.market) : item.team.desk ?? "no desk"
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].map(([key, count]) => `${key} ${count}`).join(", ")
}
