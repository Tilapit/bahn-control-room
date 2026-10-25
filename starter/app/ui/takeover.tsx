"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { clockZone } from "@/lib/time"

async function send(reference: string, action: "take" | "hand_back" | "log", note = ""): Promise<string | null> {
  const response = await fetch(`/api/orders/${encodeURIComponent(reference)}/takeover`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, note }),
  })
  const result = await response.json().catch(() => ({})) as { ok?: boolean; message?: string }
  return response.ok && result.ok ? null : result.message ?? "That did not work."
}

/** "I'll handle this": the order becomes the person's; agents and Monitor rules stop acting on it (enforced in code). */
export function TakeOverButton({ reference, className = "btn small", hint = null }: { reference: string; className?: string; hint?: React.ReactNode }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return <>
    <button type="button" className={className} disabled={busy} title="Agents and Monitor rules stop acting on this order until you hand it back"
      onClick={async () => { setBusy(true); setError(await send(reference, "take")); setBusy(false); router.refresh() }}>
      {busy ? "Taking it…" : "I'll handle this"}{hint}
    </button>
    {error && <span className="note failed-note" role="alert">{error}</span>}
  </>
}

/** The order is the person's: what they do goes on its timeline, and "Hand back to agent" gives the agent their note. */
export function TakenOverBar({ reference, since, by, zone }: { reference: string; since: string; by: string; zone: string | null }) {
  const router = useRouter()
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState<"log" | "hand_back" | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  async function act(action: "log" | "hand_back") {
    setBusy(action)
    const error = await send(reference, action, note.trim())
    setBusy(null)
    setMessage(error)
    if (!error) { setNote(""); router.refresh() }
  }
  return <div className="takeover-bar" role="region" aria-label="You are handling this order">
    <p><b>{by === "Ops" ? "You are" : `${by} is`} handling this</b> since {clockZone(since, zone)}. Agents and Monitor rules leave this order alone until you hand it back; what the agent found stays here.</p>
    <form className="reply" onSubmit={(event) => { event.preventDefault(); if (note.trim()) void act("log") }}>
      <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="What did you do? It goes on the order's timeline" aria-label="What you did" />
      <button type="submit" className="btn small" disabled={!note.trim() || !!busy}>{busy === "log" ? "Saving…" : "Add to timeline"}</button>
      <button type="button" className="btn small primary" disabled={!!busy} onClick={() => void act("hand_back")}>{busy === "hand_back" ? "Handing back…" : "Hand back to agent"}</button>
    </form>
    {message && <p className="note failed-note" role="alert">{message}</p>}
  </div>
}
