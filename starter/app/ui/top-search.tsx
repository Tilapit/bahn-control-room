"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import type { AskResult } from "@/lib/agents/ask"
import type { SearchHit } from "@/lib/case"
import { Icon } from "./icons"
import { Marked } from "./marked"

/** Search orders by reference, plate, name, city or anything said in a message. ⌘K focuses it. */
export function TopSearch() {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState<(AskResult & { question: string }) | null>(null)
  const [askError, setAskError] = useState<string | null>(null)
  // A question (ends with "?", starts with why/what/…, or is long) can go to the agents; a search still runs too.
  const question = /\?\s*$|^(why|what|when|where|who|how|is|are|was|were|does|do|did|can|could|should|will|which|has|have)\b/i.test(query.trim()) || query.trim().split(/\s+/).length >= 6

  async function askAgents() {
    const text = query.trim()
    if (!text) return
    setAsking(true)
    setAskError(null)
    setAnswer(null)
    try {
      const response = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: text }) })
      const result = await response.json() as AskResult & { error?: string }
      if (!response.ok) setAskError(result.error ?? "No answer.")
      else setAnswer({ ...result, question: text })
    } catch {
      setAskError("No answer: the request failed.")
    }
    setAsking(false)
    setOpen(true)
  }

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
    if (event.key === "Enter" && question && !(hits?.length && active > 0)) { event.preventDefault(); void askAgents(); return }
    if (!hits?.length) {
      if (event.key === "Enter" && query.trim()) { event.preventDefault(); if (hits) void askAgents(); else { setOpen(false); router.push(`/orders?q=${encodeURIComponent(query.trim())}`) } }
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
        ref={input} value={query} placeholder="Search orders, or ask: why is CD-420603 at risk?"
        onChange={(event) => { setQuery(event.target.value); setOpen(true); setAnswer(null); setAskError(null) }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKeyDown}
        aria-expanded={open && !!hits} aria-controls="search-results" role="combobox" aria-autocomplete="list"
      />
      <kbd>⌘K</kbd>
    </label>
    {open && (hits || answer || asking || askError) && <div className="search-results" id="search-results" role="listbox">
      {(question || (hits && hits.length === 0)) && !answer && <button type="button" className="search-hit ask-row" data-active={active === 0} onMouseDown={(event) => { event.preventDefault(); void askAgents() }} disabled={asking}>
        <span className="line1"><b>{asking ? "Asking the agents…" : "Ask the agents"}</b><span className="faint">Enter</span></span>
        <span className="line2" style={{ display: "block" }}>{asking ? "The Investigator is reading the records. It can only read here, not change anything." : `“${query.trim()}”, answered from the records, with sources`}</span>
      </button>}
      {askError && <p className="search-empty">{askError}</p>}
      {answer && <div className="ask-answer">
        <div className="ask-head">
          <p className="ask-question">“{answer.question}”</p>
          <button type="button" className="btn small quiet" onMouseDown={(event) => { event.preventDefault(); setOpen(false); setAnswer(null) }}>Close</button>
        </div>
        <p>{answer.answer}</p>
        {answer.sources.length > 0 && <ul className="ask-sources">
          {answer.sources.map((source) => <li key={source.entryId}>
            <a className="chip" href={source.reference ? `/orders/${source.reference}#${source.entryId}` : "#"} onMouseDown={(event) => { event.preventDefault(); if (source.reference) { setOpen(false); router.push(`/orders/${source.reference}#${source.entryId}`) } }}>
              {source.reference ? `${source.reference} · ` : ""}{source.label}{source.when ? ` · ${source.when}` : ""}
            </a>
            <span className="ask-source-text" title={source.summary}>{source.summary}</span>
          </li>)}
        </ul>}
        <p className="note ask-foot">
          {answer.runId ? "Answered by an agent from the order records. It can only read; it changed nothing." : null}
          {(() => {
            const reference = answer.sources.find((source) => source.reference)?.reference ?? answer.question.match(/CD-\d{6}/i)?.[0]?.toUpperCase()
            return reference ? <a className="ask-open" href={`/orders/${reference}`} onMouseDown={(event) => { event.preventDefault(); setOpen(false); router.push(`/orders/${reference}`) }}>Open {reference}</a> : null
          })()}
        </p>
      </div>}
      {hits && hits.length === 0 && !question && <p className="search-empty">No order matches “{query}”. Search looks at order numbers, plates, cars, names, places and every message and record on an order.</p>}
      {(hits ?? []).map((hit, index) => <a
        key={hit.orderId} href={`/orders/${hit.reference}`} className="search-hit" role="option" aria-selected={index === active} data-active={index === active}
        onMouseDown={(event) => { event.preventDefault(); go(hit.reference) }}
      >
        <span className="line1"><b>{hit.car}</b><span className="faint num">{hit.reference}</span></span>
        <span className="line2" style={{ display: "block" }}>{hit.customer} · {hit.route}</span>
        {hit.snippet && <span className="snippet" style={{ display: "block" }}>{hit.snippet.source} · {hit.snippet.when}: “<Marked text={hit.snippet.text} />”</span>}
      </a>)}
    </div>}
  </div>
}
