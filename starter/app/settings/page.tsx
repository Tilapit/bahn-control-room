import type { Metadata } from "next"
import { connection } from "next/server"
import { now as clockNow } from "@/lib/clock"
import { permissions, type PermissionRow } from "@/lib/settings"
import { When } from "../ui/when"
import { PermissionLevel } from "./permission-level"
import { SettingsNav } from "./settings-nav"

export const metadata: Metadata = { title: "Agent permissions" }

const DESK_ZONE = "Europe/Helsinki"
const LEVEL_WORDS = { auto: "does it", approval: "asks first", never: "never" } as const

/** "Approved unchanged 14 of 15 times" once you have decided proposals with this action here; nothing before that. */
function counter(row: PermissionRow): string | null {
  if (!row.decided) return null
  return `You approved it unchanged ${row.approvedUnchanged} of ${row.decided} time${row.decided === 1 ? "" : "s"}`
}

function Row({ row }: { row: PermissionRow }) {
  return <li>
    <span className="permission-label">{row.label}{(row.locked ?? counter(row) ?? (row.level === "auto" && row.limitEur)) ? <span className="sub">{row.locked ?? counter(row)}{row.level === "auto" && row.limitEur ? `${row.locked ?? counter(row) ? " · " : ""}up to €${row.limitEur}` : ""}</span> : null}</span>
    <PermissionLevel action={row.action} label={row.label} level={row.level} limitEur={row.limitEur} costs={row.costs} locked={row.locked} />
  </li>
}

function Group({ title, note, rows }: { title: string; note: string; rows: PermissionRow[] }) {
  if (!rows.length) return null
  return <section className="permission-group">
    <h2 className="section-title">{title}</h2>
    <p className="note">{note}</p>
    <ul className="permissions">{rows.map((row) => <Row key={row.action} row={row} />)}</ul>
  </section>
}

export default async function Settings() {
  await connection()
  const [{ rows, changes }, at] = await Promise.all([permissions(), clockNow()])
  const now = at.toISOString()
  return <main className="content narrow">
    <div className="page-head"><div><h1>Settings</h1><p className="page-sub">What agents may do on their own, and what they learn from your corrections.</p></div></div>
    <SettingsNav current="permissions" />
    <p className="lead">The app checks this list before every action an agent takes; agents cannot change it. Reading, asking a driver or a site and looking things up need no approval. Anything that books, costs money, changes a date or contacts a customer asks you first, unless you let the agent do it here.</p>
    <section className="permission-group">
      <h2 className="section-title">Agents do these on their own</h2>
      <p className="note">They note on the order what they did. A driver message that is part of a proposal waits for your decision on that proposal.</p>
      <ul className="permissions">
        <li><span className="permission-label">{rows.filter((row) => row.always).map((row) => row.label).join(" · ")}<span className="sub">Always allowed: reading, asking and looking up change nothing, and routine answers come from the order&apos;s records.</span></span><span className="muted">Agent does it</span></li>
        {rows.filter((row) => row.level === "auto" && !row.always).map((row) => <Row key={row.action} row={row} />)}
      </ul>
    </section>
    <Group title="Agents ask you first" note="It shows up in your For you list with the exact action and its cost; after you approve, you have 8 seconds to undo." rows={rows.filter((row) => row.level === "approval")} />
    <Group title="Never" note="Agents cannot propose these." rows={rows.filter((row) => row.level === "never")} />
    <section className="permission-group">
      <h2 className="section-title">Changes</h2>
      {changes.length === 0 ? <p className="note">Nobody has changed these yet; they are the starting rules.</p> : <ul className="changes">
        {changes.map((change) => <li key={change.id}>
          <span className="entry-time"><When iso={change.at.toISOString()} now={now} zone={DESK_ZONE} /></span>
          <span><b>{change.label}</b>: {LEVEL_WORDS[change.fromLevel as keyof typeof LEVEL_WORDS] ?? change.fromLevel} → {LEVEL_WORDS[change.toLevel as keyof typeof LEVEL_WORDS] ?? change.toLevel}{change.limitEur ? ` up to €${change.limitEur}` : ""}<span className="sub"> · {change.actor} · {change.reason}</span></span>
        </li>)}
      </ul>}
    </section>
  </main>
}
