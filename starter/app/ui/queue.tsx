"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import type { QueueItem } from "@/lib/queue"
import { CardRow, type Decided } from "./card-row"
import { useDecisionToast } from "./decision-toast"

/** The For you list. A decision removes the row at once; the toast counts down the undo window. */
export function Queue({ items, now, emptyLine, endLine }: { items: QueueItem[]; now: string; emptyLine: string; endLine?: string }) {
  const router = useRouter()
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const toast = useDecisionToast((cardId) => setHidden((set) => { const next = new Set(set); next.delete(cardId); return next }))

  function decided(result: Decided) {
    setHidden((set) => new Set(set).add(result.cardId))
    toast.show(result)
    router.refresh()
  }

  const visible = items.filter((item) => !hidden.has(item.card.id))
  return <>
    {visible.length === 0
      ? <div className="empty"><h2>Nothing needs you right now.</h2><p>{emptyLine}</p></div>
      : <><div className="queue">{visible.map((item) => <CardRow key={item.card.id} item={item} now={now} onDecided={decided} />)}</div>
        {endLine && <p className="queue-end">{endLine}</p>}</>}
    {toast.view}
  </>
}
