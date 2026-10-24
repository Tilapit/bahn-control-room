"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import type { QueueItem } from "@/lib/queue"
import { CardRow, type Decided } from "./card-row"

const UNDO_MS = 8000

/** The For you list. A decision removes the row at once; the toast offers undo. */
export function Queue({ items, now, emptyLine }: { items: QueueItem[]; now: string; emptyLine: string }) {
  const router = useRouter()
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<Decided | null>(null)

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), UNDO_MS)
    return () => clearTimeout(timer)
  }, [toast])

  function decided(result: Decided) {
    setHidden((set) => new Set(set).add(result.cardId))
    setToast(result)
    router.refresh()
  }

  async function undo() {
    if (!toast) return
    const { decisionId, cardId } = toast
    setToast(null)
    const response = await fetch(`/api/decisions/${encodeURIComponent(decisionId)}/undo`, { method: "POST" })
    if (response.ok) {
      setHidden((set) => { const next = new Set(set); next.delete(cardId); return next })
      router.refresh()
    }
  }

  const visible = items.filter((item) => !hidden.has(item.card.id))
  return <>
    {visible.length === 0
      ? <div className="empty"><h2>Nothing needs you right now.</h2><p>{emptyLine}</p></div>
      : <div className="queue">{visible.map((item) => <CardRow key={item.card.id} item={item} now={now} onDecided={decided} />)}</div>}
    {toast && <div className="toast" role="status">
      <span>{toast.message}</span>
      <button type="button" onClick={undo}>Undo</button>
    </div>}
  </>
}
