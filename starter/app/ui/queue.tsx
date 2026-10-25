"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import Link from "next/link"
import type { QueueItem, YoursWithoutCard } from "@/lib/queue"
import { dayClockZone } from "@/lib/time"
import { CardRow, type Decided } from "./card-row"
import { useDecisionToast } from "./decision-toast"
import { Icon } from "./icons"

/** Now: a person's safety, or something lost within 4 hours or already lost. Everything else waits under Later. */
export const isNow = (item: QueueItem) => item.urgency.safety || item.urgency.timeRisk

/** The desk's own clock for "nothing lost before …": the top bar shows Helsinki time too. */
const DESK = "Europe/Helsinki"

/** The For you list. A decision removes the row at once; the toast counts down the undo window. */
export function Queue({ items, now, emptyLine, endLine, yoursWithoutCard = [] }: { items: QueueItem[]; now: string; emptyLine: string; endLine?: string; yoursWithoutCard?: YoursWithoutCard[] }) {
  const router = useRouter()
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [showLater, setShowLater] = useState(false)
  const toast = useDecisionToast((cardId) => setHidden((set) => { const next = new Set(set); next.delete(cardId); return next }))

  function decided(result: Decided) {
    setHidden((set) => new Set(set).add(result.cardId))
    toast.show(result)
    router.refresh()
  }

  const visible = items.filter((item) => !hidden.has(item.card.id))
  // Orders a person took over come first, under Yours: the agent's findings stay visible, and no agent acts on them.
  const yours = visible.filter((item) => item.takenOver)
  const rest = visible.filter((item) => !item.takenOver)
  const nowItems = rest.filter(isNow)
  const later = rest.filter((item) => !isNow(item))
  // An alert's response time sorts a card but is no deadline; only real ones count for "nothing lost before".
  const firstLater = later.filter((item) => item.urgency.kind !== "alert_followup").map((item) => item.urgency.at).filter((at): at is string => !!at).sort()[0] ?? null
  const row = (item: QueueItem) => <CardRow key={item.card.id} item={item} now={now} onDecided={decided} />
  return <>
    {(yours.length > 0 || yoursWithoutCard.length > 0) && <section className="yours" aria-label="Yours">
      <h2 className="queue-section">Yours <span className="faint">· you took these over; agents are paused on them</span></h2>
      <div className="queue">
        {yours.map(row)}
        {yoursWithoutCard.map((item) => <Link className="row yours-plain" key={item.order.id} href={`/orders/${item.order.reference}`}>
          <span className="row-title">{item.order.car} · {item.open[0] ?? "nothing open on it now"}</span>
          <span className="row-ref">{item.order.reference}</span>
        </Link>)}
      </div>
    </section>}
    {rest.length === 0 && yours.length === 0 && yoursWithoutCard.length === 0
      ? <div className="empty"><h2>Nothing needs you right now.</h2><p>{emptyLine}</p></div>
      : <>
        <section aria-label="Now">
          <h2 className="queue-section">Now <span className="faint">· safety, or lost within 4 hours, or already missed</span></h2>
          {nowItems.length === 0 && <p className="note queue-note">Nothing is at risk in the next 4 hours.</p>}
          <div className="queue">{nowItems.map(row)}</div>
        </section>
        {later.length > 0 && <section aria-label="Later">
          <button type="button" className="later-toggle" aria-expanded={showLater} onClick={() => setShowLater((value) => !value)}>
            <Icon name="chevron" size={14} className="row-chevron" />
            <b>{later.length} more</b>
            <span>{firstLater ? `nothing lost before ${dayClockZone(firstLater, now, DESK)}` : "no deadline in the records"}</span>
            <span className="later-show">{showLater ? "Hide" : "Show"}</span>
          </button>
          {showLater && <div className="queue">{later.map(row)}</div>}
        </section>}
        {endLine && <p className="queue-end">{endLine}</p>}
      </>}
    {toast.view}
  </>
}
