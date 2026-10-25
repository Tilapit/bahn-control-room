"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

/** Approve runs the recorded evals first; only when they pass is the rule added to the Investigator's instructions. */
export function PlaybookActions({ id }: { id: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState<"approve" | "dismiss" | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  async function answer(value: "approve" | "dismiss") {
    setBusy(value)
    setMessage(value === "approve" ? "Running the recorded evals first…" : null)
    try {
      const response = await fetch("/api/playbook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, answer: value }) })
      const body = await response.json() as { message?: string; error?: string }
      setMessage(body.message ?? body.error ?? null)
      router.refresh()
    } finally {
      setBusy(null)
    }
  }
  return <div className="playbook-actions">
    <button type="button" className="btn small primary" disabled={!!busy} onClick={() => answer("approve")}>{busy === "approve" ? "Running the evals…" : "Approve: test, then add to the agent's rules"}</button>
    <button type="button" className="btn small" disabled={!!busy} onClick={() => answer("dismiss")}>Dismiss</button>
    {message && <p className="note" role="status">{message}</p>}
  </div>
}
