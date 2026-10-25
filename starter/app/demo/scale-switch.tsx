"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import type { ScaleState } from "@/lib/scale"

/** Scale mode: 900 synthetic quiet orders on top of the dataset's 100, to see the app at 1,000 orders. */
export function ScaleSwitch({ state }: { state: ScaleState }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  async function toggle() {
    setBusy(true)
    setMessage(null)
    const response = await fetch("/api/demo/scale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: !state.on }) })
    const result = await response.json().catch(() => ({})) as { message?: string; error?: string }
    setMessage(result.error ?? result.message ?? null)
    setBusy(false)
    router.refresh()
  }
  return <section className="demo-block scale-block" aria-label="Scale mode">
    <div className="section-title"><span>Scale mode</span><span className="count">{state.total.toLocaleString("en-GB")} orders now{state.synthetic ? `, ${state.synthetic} of them synthetic` : ""}</span></div>
    <p className="note">Adds 900 made-up quiet orders, copied from the dataset&apos;s quiet orders with new references (CD-430001 onwards), new plates and VINs, so the app runs with 1,000 orders.
      Nothing is open on them, so For you stays the same; Orders, search and the quiet checks have ten times more to go through. Takes about 6 seconds.</p>
    <div><button type="button" className="btn small" disabled={busy} onClick={toggle}>
      {busy ? (state.on ? "Removing the synthetic orders…" : "Adding 900 orders…") : state.on ? "Remove the 900 synthetic orders" : "Add 900 synthetic orders"}
    </button></div>
    {message && <p className="note" role="status">{message}</p>}
  </section>
}
