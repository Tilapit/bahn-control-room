"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import type { SearchHit } from "@/lib/case"
import { Icon } from "./icons"

/** Search orders by reference, plate, name, city or anything said in a message. ⌘K focuses it. */
export function TopSearch() {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); input.current?.focus(); input.current?.select() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    if (!query.trim()) { setHits(null); return }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((response) => response.json() as Promise<{ hits: SearchHit[] }>)
        .then((result) => { setHits(result.hits); setActive(0) })
        .catch(() => {})
    }, 120)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query])

  function go(reference: string) {
    setOpen(false)
    setQuery("")
    input.current?.blur()
    router.push(`/orders/${reference}`)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") { setOpen(false); input.current?.blur() }
    if (!hits?.length) {
      if (event.key === "Enter" && query.trim()) { setOpen(false); router.push(`/orders?q=${encodeURIComponent(query.trim())}`) }
      return
    }
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, hits.length - 1)) }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)) }
    if (event.key === "Enter") { event.preventDefault(); go(hits[active].reference) }
  }

  return <div className="search" role="search">
    <label className="search-box">
      <Icon name="search" />
      <span className="sr-only">Search orders</span>
      <input
        ref={input} value={query} placeholder="Search orders: reference, plate, name, city, anything said"
        onChange={(event) => { setQuery(event.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKeyDown}
        aria-expanded={open && !!hits} aria-controls="search-results" role="combobox" aria-autocomplete="list"
      />
      <kbd>⌘K</kbd>
    </label>
    {open && hits && <div className="search-results" id="search-results" role="listbox">
      {hits.length === 0 && <p className="search-empty">No order matches “{query}”.</p>}
      {hits.map((hit, index) => <a
        key={hit.orderId} href={`/orders/${hit.reference}`} className="search-hit" role="option" aria-selected={index === active} data-active={index === active}
        onMouseDown={(event) => { event.preventDefault(); go(hit.reference) }}
      >
        <span className="line1"><b>{hit.car}</b><span className="faint num">{hit.reference}</span></span>
        <span className="line2" style={{ display: "block" }}>{hit.customer} · {hit.route}</span>
        {hit.snippet && <span className="snippet" style={{ display: "block" }}>{hit.snippet.replaceAll("«", "").replaceAll("»", "")}</span>}
      </a>)}
    </div>}
  </div>
}
