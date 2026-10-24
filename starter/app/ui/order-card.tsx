"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import type { QueueItem } from "@/lib/queue"
import { CardRow, type Decided } from "./card-row"

const UNDO_MS = 8000

/** The open card on an order page: the same card as in For you, opened. After a decision it
 * folds into one line with Undo; the page refreshes when the undo window has passed. */
export function OrderCard({ item, now }: { item: QueueItem; now: string }) {
  const router = useRouter()
  const [done, setDone] = useState<Decided | null>(null)

  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => router.refresh(), UNDO_MS)
    return () => clearTimeout(timer)
  }, [done, router])

  async function undo() {
    if (!done) return
    const response = await fetch(`/api/decisions/${encodeURIComponent(done.decisionId)}/undo`, { method: "POST" })
    if (response.ok) setDone(null)
  }

  if (done) return <section className="case-card" aria-live="polite">
    <div className="case-card-head" style={{ justifyContent: "space-between", textTransform: "none", letterSpacing: 0, fontSize: 14, fontWeight: 500, color: "var(--text-2)", marginBottom: 12 }}>
      <span>{done.message}</span>
      <button type="button" className="btn small" onClick={undo}>Undo</button>
    </div>
  </section>

  return <section className={`case-card${item.urgency.safety ? " safety" : ""}`} aria-label="Needs you">
    <div className="case-card-head">
      <span className={`mark ${item.urgency.safety ? "safety" : item.urgency.timeRisk ? "time" : ""}`} aria-hidden="true" />
      <span>Needs you</span>
    </div>
    <CardRow item={item} now={now} open onOrderPage onDecided={setDone} />
  </section>
}
