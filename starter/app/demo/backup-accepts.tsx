"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import type { BackupState } from "@/lib/backup"

/** Scenario 4's last step: the backup driver says yes in the driver app. Code, no model: it works without an API key. */
export function BackupAccepts() {
  const router = useRouter()
  const [state, setState] = useState<BackupState | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await fetch("/api/demo/backup", { cache: "no-store" })
    if (response.ok) setState(await response.json() as BackupState | null)
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [load])

  async function accept() {
    setBusy(true)
    setNotice(null)
    try {
      const response = await fetch("/api/demo/backup", { method: "POST" })
      const result = await response.json().catch(() => ({})) as { message?: string }
      setNotice(result.message ?? (response.ok ? "Done." : "That did not work."))
      await load()
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const offered = state?.offeredTo ?? null
  const label = offered ? `Backup driver accepts: ${offered} takes the gig` : "Backup driver accepts"
  return <section className="demo-block" aria-label="Backup driver">
    <div className="section-title"><span>Scenario 4: backup driver ({state?.reference ?? "CD-420449"})</span></div>
    <p className="note">
      {state?.acceptedBy ? `${state.acceptedBy} has accepted the gig.${state.travel.length ? " The replaced driver's travel is still booked until you approve the card on For you." : " The replaced driver has no travel left booked."}`
        : offered ? `The gig is offered to ${offered}, not accepted yet. Pressing the button records ${offered}'s yes in the driver app (fictional); code then puts a card on For you to cancel the replaced driver's ${state?.travel.length ? "travel" : "bookings"}, which the Executor carries out after you approve it and the 8-second undo window.`
        : "Approve the offer on For you first: until a card has offered the gig to a backup driver, nobody can accept it."}
    </p>
    <div className="demo-row">
      <button type="button" className="btn small" disabled={busy || !offered} onClick={accept}>{busy ? "Recording…" : label}</button>
      {notice && <span className="note" role="status">{notice}</span>}
    </div>
  </section>
}
