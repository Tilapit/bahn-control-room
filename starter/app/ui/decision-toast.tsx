"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import type { Decided } from "./card-row"

const DONE: Record<string, string> = {
  Booking: "Booked",
  "Sending the email": "Email sent",
  Rejecting: "Rejected",
  "Sending to the agent": "Sent to the agent. It is working on it",
  "Offering the gig": "Gig offered",
  "Changing the time": "Time changed",
  "Handing you the call": "The call is yours: who to call and what to ask are on the order page",
  "Marking as handled": "Marked as handled",
  "Carrying it out": "Done",
}

type Toast = Decided & { phase: "waiting" | "done" | "failed"; doneText?: string }

/**
 * The undo window after a decision (SPEC 8): "Booking in 8 s · Undo", counting down.
 * At zero the page asks the server to carry it out (the server's own timer does too),
 * then shows what happened. Undo inside the window brings the card back.
 */
export function useDecisionToast(onUndone: (cardId: string) => void) {
  const router = useRouter()
  const [toast, setToast] = useState<Toast | null>(null)
  const [, tick] = useState(0)

  const show = useCallback((decided: Decided) => setToast({ ...decided, phase: "waiting" }), [])

  useEffect(() => {
    if (!toast) return
    if (toast.phase !== "waiting") {
      const timer = setTimeout(() => setToast(null), toast.phase === "failed" ? 9000 : 3500)
      return () => clearTimeout(timer)
    }
    const executesAt = toast.executesAt ? new Date(toast.executesAt).getTime() : Date.now()
    const interval = setInterval(() => tick((n) => n + 1), 250)
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/decisions/${encodeURIComponent(toast.decisionId)}/finalize`, { method: "POST" })
        const result = await response.json() as { ok?: boolean; summary?: string }
        const word = toast.message.replace(/ in \d+ s$/, "")
        setToast((current) => current && current.decisionId === toast.decisionId
          ? result.ok === false ? { ...current, phase: "failed", doneText: result.summary ?? "Not carried out" } : { ...current, phase: "done", doneText: DONE[word] ?? "Done" }
          : current)
      } catch {
        setToast((current) => current && { ...current, phase: "done", doneText: "Done" })
      }
      router.refresh()
    }, Math.max(0, executesAt - Date.now()) + 50)
    return () => { clearInterval(interval); clearTimeout(timer) }
  }, [toast, router])

  async function undo() {
    if (!toast) return
    const { decisionId, cardId } = toast
    const response = await fetch(`/api/decisions/${encodeURIComponent(decisionId)}/undo`, { method: "POST" })
    if (response.ok) {
      setToast(null)
      onUndone(cardId)
      router.refresh()
    } else {
      const result = await response.json().catch(() => ({})) as { error?: string }
      setToast((current) => current && { ...current, phase: "failed", doneText: result.error ?? "Too late to undo." })
    }
  }

  let view: React.ReactNode = null
  if (toast) {
    const seconds = toast.executesAt ? Math.max(0, Math.ceil((new Date(toast.executesAt).getTime() - Date.now()) / 1000)) : 0
    const word = toast.message.replace(/ in \d+ s$/, "")
    view = <div className={`toast${toast.phase === "failed" ? " failed" : ""}`} role="status" aria-live="polite">
      <div className="toast-body">
        <div className="toast-line">{toast.reference && <b className="toast-ref">{toast.reference}</b>}{toast.car && <span className="toast-car">{toast.car}</span>}
          <span>{toast.phase === "waiting" ? (/ in \d+ s$/.test(toast.message) ? `${word} in ${seconds} s` : toast.message) : toast.doneText}</span></div>
        {toast.phase === "waiting" && toast.what && <div className="toast-what">{toast.what}.</div>}
      </div>
      {toast.phase === "waiting" ? <button type="button" onClick={undo}>Undo</button>
        : toast.reference?.startsWith("CD-") ? <a className="toast-link" href={`/orders/${toast.reference}`}>Open order</a> : null}
    </div>
  }
  return { show, view, active: toast }
}
