"use client"

import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { DEFAULT_VIEW, DESKS, type Desk, inView, MARKETS, parseView, passesThrough, type Team, type TeamView, viewLabel } from "@/lib/teams"

/** Saved per person in this browser. A private window or blocked storage just starts from Everyone. */
const KEY = "bahn.teamView.v1"
const EVENT = "bahn:team-view"

let cached: { raw: string | null; view: TeamView } = { raw: null, view: DEFAULT_VIEW }

function read(): TeamView {
  let raw: string | null = null
  try { raw = window.localStorage.getItem(KEY) } catch { raw = null }
  if (raw === cached.raw) return cached.view
  let view = DEFAULT_VIEW
  try { view = raw ? parseView(JSON.parse(raw)) : DEFAULT_VIEW } catch { view = DEFAULT_VIEW }
  cached = { raw, view }
  return view
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange)
  window.addEventListener("storage", onChange)
  return () => { window.removeEventListener(EVENT, onChange); window.removeEventListener("storage", onChange) }
}

/** The person's team view, the same in every component on the page (the rail badge, the list, the header). */
export function useTeamView(): [TeamView, (view: TeamView) => void] {
  const view = useSyncExternalStore(subscribe, read, () => DEFAULT_VIEW)
  const set = (next: TeamView) => {
    try { window.localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* the view lasts until the page reloads */ }
    cached = { raw: JSON.stringify(next), view: next }
    window.dispatchEvent(new Event(EVENT))
  }
  return [view, set]
}

/** "Finland · All desks ▾": pick a market, some desks, and whether orders passing through count too. */
export function ViewSwitcher() {
  const [view, setView] = useTeamView()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    document.addEventListener("keydown", close)
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close) }
  }, [open])
  const toggleDesk = (desk: Desk) => setView({ ...view, desks: view.desks.includes(desk) ? view.desks.filter((item) => item !== desk) : DESKS.filter((item) => item === desk || view.desks.includes(item)) })
  return <div className="view-switch" ref={box}>
    <button type="button" className="view-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {viewLabel(view)} <span aria-hidden="true">▾</span>
    </button>
    {open && <div className="view-pop" role="dialog" aria-label="Choose your view">
      <fieldset>
        <legend>Market: the customer&apos;s country</legend>
        {(["Everyone", ...MARKETS] as TeamView["market"][]).map((market) => <label key={market} className="view-option">
          <input type="radio" name="view-market" checked={view.market === market} onChange={() => setView({ ...view, market })} />
          {market === "Other" ? "Other countries" : market}
        </label>)}
      </fieldset>
      <fieldset>
        <legend>Desks</legend>
        {DESKS.map((desk) => <label key={desk} className="view-option">
          <input type="checkbox" checked={view.desks.includes(desk)} onChange={() => toggleDesk(desk)} />{desk}
        </label>)}
        <p className="view-hint">None ticked shows every desk.</p>
      </fieldset>
      <label className="view-option view-through">
        <input type="checkbox" checked={view.passingThrough} disabled={view.market === "Everyone" || view.market === "Other"}
          onChange={() => setView({ ...view, passingThrough: !view.passingThrough })} />
        Include orders passing through my country
      </label>
      {(view.market !== "Everyone" || view.desks.length > 0) && <button type="button" className="link view-reset" onClick={() => setView(DEFAULT_VIEW)}>Show everyone at every desk</button>}
    </div>}
  </div>
}

/** "Cross-border" after a row: its route leaves the customer's country. The hover line names the countries. */
export function CrossBorder({ team }: { team: Team }) {
  const [view] = useTeamView()
  if (!team.crossBorder) return null
  const through = passesThrough(team, view)
  return <span className="tag cross" title={`${through ? `In your view because it passes through ${view.market}. ` : ""}Customer in ${team.market === "Other" ? "another country" : team.market}; the route touches ${team.countries.join(", ")}.`}>Cross-border</span>
}

export type TeamRow = { key: string; team: Team; node: ReactNode }

/** The empty state for a view with nothing in it, with a way back to everyone. */
function Empty({ view, hint }: { view: TeamView; hint?: string }) {
  const [, setView] = useTeamView()
  return <div className="empty">
    <h2>Nothing in {viewLabel(view)} right now.</h2>
    <p>{hint ?? "Other markets and desks may have something."} <button type="button" className="link" onClick={() => setView(DEFAULT_VIEW)}>Show everyone</button></p>
  </div>
}

/** A table whose rows follow the view; with none left, the empty state instead of an empty table. */
export function TeamTable({ head, rows, className, label, hint }: { head: ReactNode; rows: TeamRow[]; className: string; label: string; hint?: string }) {
  const [view] = useTeamView()
  const shown = rows.filter((row) => inView(row.team, view))
  if (!shown.length) return <Empty view={view} hint={hint} />
  return <>
    {shown.length < rows.length && <p className="note view-note">Showing {shown.length} of the {rows.length} orders on this page: {viewLabel(view)}.</p>}
    <div className={className} role="table" aria-label={label}>{head}{shown.map((row) => <span key={row.key} style={{ display: "contents" }}>{row.node}</span>)}</div>
  </>
}

/** One group of a list (a heading, its rows): hidden when nothing in it is in the view, counted after the filter. */
export function TeamGroup({ title, note, rows, listClassName = "runs" }: { title: string; note?: string; rows: TeamRow[]; listClassName?: string }) {
  const [view] = useTeamView()
  const shown = rows.filter((row) => inView(row.team, view))
  if (!shown.length) return null
  return <section>
    <p className="runs-group">{title} ({shown.length}){note ? `: ${note}` : ""}</p>
    <ol className={listClassName}>{shown.map((row) => <li key={row.key}>{row.node}</li>)}</ol>
  </section>
}

/** A plain list that follows the view, with the empty state when the view leaves nothing. */
export function TeamList({ rows, listClassName = "runs", hint }: { rows: TeamRow[]; listClassName?: string; hint?: string }) {
  const [view] = useTeamView()
  const shown = rows.filter((row) => inView(row.team, view))
  if (!shown.length) return <Empty view={view} hint={hint} />
  return <ol className={listClassName}>{shown.map((row) => <li key={row.key}>{row.node}</li>)}</ol>
}

/** Only when the row's team is in the view. */
export function InView({ team, children }: { team: Team; children: ReactNode }) {
  const [view] = useTeamView()
  return inView(team, view) ? <>{children}</> : null
}

/** A number counted inside the view: "Waiting for you (3)". */
export function CountInView({ teams }: { teams: Team[] }) {
  const [view] = useTeamView()
  return <>{teams.filter((team) => inView(team, view)).length}</>
}

/** Is anything of these in the view? For a row that summarises several. */
export function AnyInView({ teams, children }: { teams: Team[]; children: ReactNode }) {
  const [view] = useTeamView()
  return teams.some((team) => inView(team, view)) ? <>{children}</> : null
}

/** The empty state of a page whose groups the view left empty. */
export function NoneInView({ teams, hint }: { teams: Team[]; hint?: string }) {
  const [view] = useTeamView()
  return teams.length > 0 && !teams.some((team) => inView(team, view)) ? <Empty view={view} hint={hint} /> : null
}
