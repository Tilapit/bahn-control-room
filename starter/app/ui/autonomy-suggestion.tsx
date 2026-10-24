"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import type { Suggestion } from "@/lib/autonomy"

/** One quiet line above the queue: the agent has earned the right to do one kind of action without asking. */
export function AutonomySuggestion({ suggestion }: { suggestion: Suggestion }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  async function answer(value: "yes" | "not_now") {
    setBusy(true)
    const response = await fetch("/api/autonomy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: suggestion.action, answer: value }) })
    const result = await response.json().catch(() => ({})) as { message?: string; error?: string }
    setMessage(result.message ?? result.error ?? "Saved.")
    setBusy(false)
    router.refresh()
  }
  if (message) return <p className="suggestion done" role="status">{message}</p>
  return <section className="suggestion" aria-label="Suggestion">
    <p>{suggestion.text}</p>
    <div className="suggestion-actions">
      <button type="button" className="btn small" disabled={busy} onClick={() => answer("yes")}>{suggestion.yesLabel}</button>
      <button type="button" className="btn small quiet" disabled={busy} onClick={() => answer("not_now")}>Not now</button>
    </div>
    <p className="note">Customer contact and promised delivery dates always stay with a person. You can change this in Settings.</p>
  </section>
}
