"use client"

import { useState } from "react"
import { inView, type Team } from "@/lib/teams"
import { type TeamRow, useTeamView } from "../ui/view-switcher"

/** "5 suggestions", "1 suggestion": a count inside the person's view, with its noun. */
export function CountWords({ teams, one, many }: { teams: Team[]; one: string; many: string }) {
  const [view] = useTeamView()
  const n = teams.filter((team) => inView(team, view)).length
  return <>{n} {n === 1 ? one : many}</>
}

/** The first few rows of a list that follows the person's view, and "Show N more" for the rest. */
export function ShowMore({ rows, initial = 3, className, empty }: { rows: TeamRow[]; initial?: number; className: string; empty: string }) {
  const [view] = useTeamView()
  const [all, setAll] = useState(false)
  const shown = rows.filter((row) => inView(row.team, view))
  if (!shown.length) return <p className="note ag-empty">{empty}</p>
  const visible = all ? shown : shown.slice(0, initial)
  return <>
    <ol className={className}>{visible.map((row) => <li key={row.key}>{row.node}</li>)}</ol>
    {shown.length > initial && <p className="ag-more-wrap">
      <button type="button" className="ag-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
        {all ? "Show fewer" : `Show ${shown.length - initial} more`}
      </button>
    </p>}
  </>
}
