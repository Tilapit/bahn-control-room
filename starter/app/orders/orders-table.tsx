"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { DEFAULT_VIEW, inView, type Team, viewLabel } from "@/lib/teams"
import { Marked } from "../ui/marked"
import { CrossBorder, useTeamView } from "../ui/view-switcher"

/** One order in the table: plain words and numbers worked out on the server. */
export type OrderRow = {
  id: string
  reference: string
  car: string
  route: string
  stage: string
  /** The stage as a sentence, on hover. */
  stageTitle: string
  status: string
  due: string
  dueTitle: string
  tone: "safety" | "time" | ""
  /** Red only for a person's safety, amber for time risk, the accent while an agent works, grey otherwise. */
  dot: "safety" | "time" | "agent" | "open" | "none"
  who: { kind: "you" | "colleague" | "unclaimed" | "agent" | "quiet"; label: string; initials: string; title: string }
  team: Team
  snippet: { text: string; source: string; when: string } | null
}

/** Rows per page: a screen and a bit, like the mock. */
const PAGE = 25

/** The stage menu inside the search field: choosing one searches at once. */
export function StageSelect({ value, total, options }: { value: string; total: number; options: { value: string; label: string; count: number }[] }) {
  return <label className="o-stage">
    <span className="sr-only">Stage</span>
    <select name="stage" defaultValue={value} onChange={(event) => event.currentTarget.form?.requestSubmit()}>
      <option value="">Any stage · {total.toLocaleString("en-GB")}</option>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label} · {option.count.toLocaleString("en-GB")}</option>)}
    </select>
  </label>
}

/** "Y" for you, initials for a colleague, a dashed circle when nobody has it, a light one for an agent. */
function Who({ who }: { who: OrderRow["who"] }) {
  if (who.kind === "quiet") return <span className="o-who quiet" title={who.title}>—</span>
  return <span className={`o-who ${who.kind}`} title={who.title}>
    <span className="o-avatar" aria-hidden="true">{who.kind === "you" || who.kind === "colleague" ? who.initials : ""}</span>{who.label}
  </span>
}

/** The table follows the person's team view, then pages through what is left, 25 at a time. */
export function OrdersTable({ rows }: { rows: OrderRow[] }) {
  const [view, setView] = useTeamView()
  const [page, setPage] = useState(0)
  const shown = rows.filter((row) => inView(row.team, view))
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  // A new filter or view starts on the first page; a live refresh of the same list keeps the page.
  const listKey = `${rows.length}:${rows[0]?.id ?? ""}:${viewLabel(view)}:${view.passingThrough}`
  useEffect(() => { setPage(0) }, [listKey])
  const current = Math.min(page, pages - 1)
  const slice = shown.slice(current * PAGE, current * PAGE + PAGE)

  if (!shown.length) return <div className="empty">
    <h2>Nothing in {viewLabel(view)} here.</h2>
    <p>Other markets and desks may have some. <button type="button" className="link" onClick={() => setView(DEFAULT_VIEW)}>Show everyone</button></p>
  </div>

  return <>
    <div className="o-table" role="table" aria-label="Orders">
      <div className="o-row o-head" role="row">
        {["Car", "Order", "Route", "Stage", "What's happening", "Due", "Who"].map((label) => <span role="columnheader" key={label}>{label}</span>)}
      </div>
      {slice.map((row) => <Link key={row.id} className={`o-row${row.tone ? ` ${row.tone}` : ""}`} role="row" href={`/orders/${row.reference}`}>
        <span role="cell" className="o-car" title={row.car}><span className={`o-dot ${row.dot}`} aria-hidden="true" /><span className="o-text">{row.car}</span></span>
        <span role="cell" className="o-ref">{row.reference}</span>
        <span role="cell" className="o-route" title={row.route}><span className="o-text">{row.route}</span><CrossBorder team={row.team} /></span>
        <span role="cell" className="o-stage-cell" title={row.stageTitle}>{row.stage}</span>
        <span role="cell" className="o-status" title={row.status}>{row.status}</span>
        <span role="cell" className={`o-due ${row.tone}`} title={row.dueTitle}>{row.due}</span>
        <span role="cell"><Who who={row.who} /></span>
        {row.snippet && <span className="o-snippet">{row.snippet.source} · {row.snippet.when}: “<Marked text={row.snippet.text} />”</span>}
      </Link>)}
    </div>
    <div className="o-foot">
      <p>Showing {slice.length.toLocaleString("en-GB")} of {shown.length.toLocaleString("en-GB")}{shown.length < rows.length ? ` in ${viewLabel(view)}` : ""}{pages > 1 ? " · search or filter to find the rest" : ""}</p>
      {pages > 1 && <div className="o-pages">
        <button type="button" className="btn small" disabled={current === 0} onClick={() => { setPage(current - 1); window.scrollTo({ top: 0 }) }}>Previous</button>
        <span className="o-page-n">Page {current + 1} of {pages}</span>
        <button type="button" className="btn small" disabled={current >= pages - 1} onClick={() => { setPage(current + 1); window.scrollTo({ top: 0 }) }}>Next</button>
      </div>}
    </div>
  </>
}
