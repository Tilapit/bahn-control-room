"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef } from "react"

/** Refreshes the page when agents or people change something, so a new card appears without a reload. */
export function LiveRefresh({ every = 3000 }: { every?: number }) {
  const router = useRouter()
  const last = useRef<string | null>(null)
  useEffect(() => {
    let stopped = false
    const check = async () => {
      try {
        const response = await fetch("/api/activity", { cache: "no-store" })
        const { version } = await response.json() as { version: string }
        // Do not refresh under a person's hands: an open undo toast or a focused reply box waits.
        const busy = document.querySelector(".toast") || (document.activeElement instanceof HTMLInputElement && document.activeElement.value)
        if (last.current && version !== last.current && !busy) router.refresh()
        if (!busy) last.current = version
      } catch { /* offline for a moment; try again next tick */ }
      if (!stopped) setTimeout(check, every)
    }
    void check()
    return () => { stopped = true }
  }, [router, every])
  return null
}
