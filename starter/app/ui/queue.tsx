"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import Link from "next/link"
import type { QueueItem, YoursWithoutCard } from "@/lib/queue"
import { CardRow, type Decided } from "./card-row"
import { useDecisionToast } from "./decision-toast"

/** The For you list. A decision removes the row at once; the toast counts down the undo window. */
export function Queue({ items, now, emptyLine, endLine, yoursWithoutCard = [] }: { items: QueueItem[]; now: string; emptyLine: string; endLine?: string; yoursWithoutCard?: YoursWithoutCard[] }) {
  const router = useRouter()
  const [hidden, setHidden] = useState<Set<string>>(new Set())
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
  return <>
    {(yours.length > 0 || yoursWithoutCard.length > 0) && <section className="yours" aria-label="Yours">
      <h2 className="queue-section">Yours <span className="faint">· you took these over; agents are paused on them</span></h2>
      <div className="queue">
        {yours.map((item) => <CardRow key={item.card.id} item={item} now={now} onDecided={decided} />)}
        {yoursWithoutCard.map((item) => <Link className="row yours-plain" key={item.order.id} href={`/orders/${item.order.reference}`}>
          <span className="row-title">{item.order.car}: {item.open[0] ?? "nothing open on it now"}</span>
          <span className="row-ref">{item.order.reference}</span>
        </Link>)}
      </div>
    </section>}
    {rest.length === 0 && yours.length === 0 && yoursWithoutCard.length === 0
      ? <div className="empty"><h2>Nothing needs you right now.</h2><p>{emptyLine}</p></div>
      : <>{rest.length > 0 && yours.length + yoursWithoutCard.length > 0 && <h2 className="queue-section">Needs you</h2>}
        <div className="queue">{rest.map((item) => <CardRow key={item.card.id} item={item} now={now} onDecided={decided} />)}</div>
        {endLine && <p className="queue-end">{endLine}</p>}</>}
    {toast.view}
  </>
}
