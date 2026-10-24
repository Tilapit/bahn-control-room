"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef } from "react"

/** Do not refresh under a person's hands: an open undo toast or a half-typed reply waits. */
function busy(): boolean {
  const active = document.activeElement
  return !!document.querySelector(".toast") || ((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && !!active.value)
}

/**
 * Refreshes the page when agents or people change something, so a new card or a run's next step
 * appears without a reload. Listens to the server's event stream; polls if the stream is unavailable.
 */
export function LiveRefresh({ every = 3000 }: { every?: number }) {
  const router = useRouter()
  const last = useRef<string | null>(null)
  const pending = useRef(false)
  useEffect(() => {
    let stopped = false
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let waitTimer: ReturnType<typeof setTimeout> | null = null
    const seen = (version: string) => {
      if (last.current !== null && version !== last.current) pending.current = true
      last.current = version
      apply()
    }
    // A change that arrives while a person is typing or can still undo is applied when they are done.
    const apply = () => {
      if (!pending.current || stopped) return
      if (busy()) { waitTimer ??= setTimeout(() => { waitTimer = null; apply() }, 1000); return }
      pending.current = false
      router.refresh()
    }
    const poll = async () => {
      try {
        const response = await fetch("/api/activity", { cache: "no-store" })
        seen(((await response.json()) as { version: string }).version)
      } catch { /* offline for a moment */ }
      if (!stopped) pollTimer = setTimeout(poll, every)
    }
    let source: EventSource | null = null
    if (typeof EventSource !== "undefined") {
      source = new EventSource("/api/stream")
      source.addEventListener("version", (event) => seen((JSON.parse((event as MessageEvent).data) as { version: string }).version))
      let failures = 0
      source.onerror = () => {
        failures += 1
        // The browser reconnects by itself; after repeated failures fall back to polling.
        if (failures > 3 && source) { source.close(); source = null; void poll() }
      }
      source.onopen = () => { failures = 0 }
    } else void poll()
    return () => {
      stopped = true
      source?.close()
      if (pollTimer) clearTimeout(pollTimer)
      if (waitTimer) clearTimeout(waitTimer)
    }
  }, [router, every])
  return null
}
