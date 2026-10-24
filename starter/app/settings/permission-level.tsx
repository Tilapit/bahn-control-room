"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

const WORDS = { auto: "Agent does it", approval: "Agent asks you first", never: "Never" } as const

/** The level selector for one action, with a cost limit when "does it" applies to something that costs money. */
export function PermissionLevel({ action, label, level, limitEur, costs, locked }: { action: string; label: string; level: keyof typeof WORDS; limitEur: number | null; costs: boolean; locked: string | null }) {
  const router = useRouter()
  const [value, setValue] = useState(level)
  const [limit, setLimit] = useState(limitEur ? String(limitEur) : "")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  async function save(next: keyof typeof WORDS, nextLimit = limit) {
    setSaving(true)
    setError(null)
    const response = await fetch("/api/policies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, level: next, limitEur: nextLimit ? Number(nextLimit) : null }) })
    const result = await response.json().catch(() => ({})) as { error?: string }
    if (!response.ok) { setError(result.error ?? "Not saved."); setValue(level) }
    setSaving(false)
    router.refresh()
  }
  if (locked) return <span className="muted">{WORDS[level]}</span>
  return <span className="permission-control">
    <select aria-label={`What the agent may do: ${label}`} className="demo-select" value={value} disabled={saving} onChange={(event) => { const next = event.target.value as keyof typeof WORDS; setValue(next); void save(next) }}>
      {(Object.keys(WORDS) as (keyof typeof WORDS)[]).map((key) => <option key={key} value={key}>{WORDS[key]}</option>)}
    </select>
    {value === "auto" && costs && <label className="limit">up to €<input inputMode="numeric" value={limit} placeholder="no limit" onChange={(event) => setLimit(event.target.value.replace(/[^0-9]/g, ""))} onBlur={() => save("auto", limit)} aria-label={`Cost limit for ${label}`} /></label>}
    {error && <span className="failed-note">{error}</span>}
  </span>
}
