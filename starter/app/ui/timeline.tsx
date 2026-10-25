"use client"

import { useEffect, useMemo, useState } from "react"
import type { TimelineItem } from "@/lib/case"
import { sourceKind } from "@/lib/sources"
import { SOURCE_FILTERS } from "@/lib/timeline/sources"
import { Icon } from "./icons"
import { clock, duration, long, minutesUntil, relative } from "@/lib/time"

type Group = { key: string; label: string; runs: Run[] }
type Run = { key: string; entries: TimelineItem[]; gps: boolean }

function dayKey(iso: string, zone: string | null): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso))
}

function dayLabel(iso: string, now: string, zone: string | null): string {
  const key = dayKey(iso, zone)
  if (key === dayKey(now, zone)) return "Today"
  if (key === dayKey(new Date(new Date(now).getTime() - 86_400_000).toISOString(), zone)) return "Yesterday"
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone ?? "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(iso))
}

/** Words that keep evidence honest: a quote is not a booking, an alert is a signal. */
function badges(entry: TimelineItem): { text: string; tone: string }[] {
  const list: { text: string; tone: string }[] = []
  if (entry.status === "quote") list.push({ text: "Quote, not booked", tone: "quote" })
  if (entry.status === "booked") list.push({ text: "Booked", tone: "booked" })
  if (entry.source === "booking" && entry.status === "superseded") list.push({ text: "Booking lost", tone: "" })
  if (entry.kind === "alert") list.push({ text: entry.status === "done" ? "Closed" : "Signal, not a diagnosis", tone: entry.status === "done" ? "" : "signal" })
  if (entry.channel === "ferry_schedule_inference") list.push({ text: "Estimate, not a position", tone: "signal" })
  if (entry.kind === "fact") list.push(entry.status === "verified" ? { text: "Confirmed", tone: "booked" } : { text: "Not confirmed", tone: "signal" })
  if (entry.kind === "proposal") list.push({ text: "Proposal", tone: "" })
  if (entry.kind === "message" && entry.visibility === "internal" && entry.source !== "slack") list.push({ text: "Internal", tone: "internal" })
  // Played by the demo (a scenario message or the simulated driver or site answering an agent), not a real person.
  if (entry.evidence?.table === "demo_events") list.push({ text: "Simulated in the demo", tone: "internal" })
  const late = entry.receivedAt ? minutesUntil(entry.receivedAt, entry.at) : null
  if (late != null && late <= -10) list.push({ text: `arrived ${duration(-late)} later`, tone: "internal" })
  return list
}

function isMinor(entry: TimelineItem): boolean {
  return entry.source === "system" || (entry.kind === "event" && entry.source === "order" && entry.status !== "claimed") || entry.kind === "fact"
}

export function Timeline({ entries, now, zone, place, zoneName }: { entries: TimelineItem[]; now: string; zone: string | null; place: string | null; zoneName?: string | null }) {
  const [filter, setFilter] = useState("all")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Every entry falls under one pill, so the pills add up to All: what no channel claims is "Other" (system, order record, documents).
  const filters = useMemo(() => [...SOURCE_FILTERS.map((f) => ({ key: f.key, label: f.label, test: (entry: TimelineItem) => (f.sources as string[]).includes(entry.source) })),
    { key: "other", label: "Other", test: (entry: TimelineItem) => !SOURCE_FILTERS.some((f) => (f.sources as string[]).includes(entry.source)) }], [])
  const counts = useMemo(() => Object.fromEntries(filters.map((f) => [f.key, entries.filter(f.test).length])), [entries, filters])
  const visible = useMemo(() => {
    const active = filters.find((f) => f.key === filter)
    return [...entries]
      .filter((entry) => !active || active.test(entry))
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
  }, [entries, filter, filters])

  const groups = useMemo(() => {
    const result: Group[] = []
    for (const entry of visible) {
      const key = dayKey(entry.at, zone)
      let group = result[result.length - 1]
      if (!group || group.key !== key) { group = { key, label: dayLabel(entry.at, now, zone), runs: [] }; result.push(group) }
      const gps = entry.source === "gps" && filter !== "gps"
      const run = group.runs[group.runs.length - 1]
      if (run && run.gps && gps) run.entries.push(entry)
      else group.runs.push({ key: entry.id, entries: [entry], gps })
    }
    return result
  }, [visible, zone, now, filter])

  // A link to one entry (from a card's source chip) opens the run that holds it.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1))
    if (!id) return
    const run = groups.flatMap((group) => group.runs).find((candidate) => candidate.entries.some((entry) => entry.id === id))
    if (run && run.entries.length > 1 && run.entries[0].id !== id) setExpanded((set) => new Set(set).add(run.key))
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "center" }))
  }, [groups])

  return <section aria-label="Timeline">
    <div className="section-title"><span>Timeline</span><span className="count">Every channel, newest first{place ? ` · times in ${place} time${zoneName ? ` (${zoneName})` : ""}` : ""}</span></div>
    <div className="filters" role="toolbar" aria-label="Show entries from">
      <button type="button" className="filter" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All <span className="n">{entries.length}</span></button>
      {filters.filter((f) => counts[f.key] > 0).map((f) => <button key={f.key} type="button" className="filter" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
        {f.label} <span className="n">{counts[f.key]}</span>
      </button>)}
    </div>
    {visible.length === 0 && <p className="note">Nothing from this source on this order.</p>}
    {groups.map((group) => <div className="day" key={group.key}>
      <div className="day-label">{group.label}</div>
      <ol className="entries">
        {group.runs.map((run) => {
          const open = !run.gps || run.entries.length === 1 || expanded.has(run.key)
          const shown = open ? run.entries : run.entries.slice(0, 1)
          return <li key={run.key} style={{ display: "contents" }}>
            {shown.map((entry) => <Entry key={entry.id} entry={entry} now={now} zone={zone} />)}
            {!open && <button type="button" className="collapsed-gps" onClick={() => setExpanded((set) => new Set(set).add(run.key))}>
              {run.entries.length - 1} earlier GPS position{run.entries.length - 1 === 1 ? "" : "s"} this day
            </button>}
          </li>
        })}
      </ol>
    </div>)}
  </section>
}

function Entry({ entry, now, zone }: { entry: TimelineItem; now: string; zone: string | null }) {
  const who = entry.authorLabel ?? entry.chip
  const text = entry.kind === "message" && entry.body ? entry.body : entry.summary
  // Older look-up records list each option behind its internal id ("- hotel:norderkai-lodge:…: "); people see only the option.
  const extra = entry.kind === "message" ? null : entry.body?.replace(/^- [a-z]+:\S+: /gm, "") ?? null
  return <div id={entry.id} className={`entry ${entry.kind}${isMinor(entry) ? " minor" : ""}`}>
    <time className="entry-time" dateTime={entry.at} title={`${long(entry.at, zone)} (${relative(entry.at, now)})`}>{clock(entry.at, zone)}</time>
    <div>
      <div className="entry-head">
        <span className="entry-who">{who}</span>
        <span className="entry-src"><Icon name={sourceKind(entry.source).icon} size={13} />{entry.sourceLabel}{entry.language && entry.language !== "en" ? ` · written in ${new Intl.DisplayNames(["en"], { type: "language" }).of(entry.language)}` : ""}</span>
        {badges(entry).filter((badge) => badge.text !== entry.sourceLabel).map((badge) => <span key={badge.text} className={`entry-badge ${badge.tone}`}>{badge.text}</span>)}
      </div>
      <p className="entry-summary">{text}</p>
      {extra && <p className="entry-body">{extra}</p>}
    </div>
  </div>
}
