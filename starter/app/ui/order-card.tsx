"use client"

import { useState } from "react"
import type { QueueItem } from "@/lib/queue"
import { CaseDetail, type Decided } from "./card-row"
import { useDecisionToast } from "./decision-toast"

/** The open card on an order page: the same card as in For you, opened. After a decision it
 * folds into one line while the undo window counts down; the page refreshes when it has been carried out. */
export function OrderCard({ item, now }: { item: QueueItem; now: string }) {
  const [done, setDone] = useState<Decided | null>(null)
  const toast = useDecisionToast(() => setDone(null))

  function decided(result: Decided) {
    setDone(result)
    toast.show(result)
  }

  if (done) return <section className="case-card folded" aria-live="polite">
    <p className="note">Decided: {item.card.headline.replace(/^[^:]+:\s*/, "")}. {toast.active?.phase === "waiting" ? "You can still undo it below." : ""}</p>
    {toast.view}
  </section>

  return <section className={`case-card${item.urgency.safety ? " safety" : ""}`} aria-label="Needs you">
    <div className="case-card-head">
      <span className={`mark ${item.urgency.safety ? "safety" : item.urgency.timeRisk ? "time" : ""}`} aria-hidden="true" />
      <span>Needs you</span>
    </div>
    <CaseDetail item={item} now={now} onOrderPage onDecided={decided} />
  </section>
}
