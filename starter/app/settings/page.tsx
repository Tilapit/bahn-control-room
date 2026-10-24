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

function counter(row: PermissionRow): string {
  if (!row.decided) return "Not decided on a card yet"
  return `Approved unchanged ${row.approvedUnchanged} of ${row.decided} time${row.decided === 1 ? "" : "s"}`
}

function Group({ title, note, rows }: { title: string; note: string; rows: PermissionRow[] }) {
  if (!rows.length) return null
  return <section className="permission-group">
    {title && <h2 className="section-title">{title}</h2>}
    {note && <p className="note">{note}</p>}
    <ul className="permissions">
      {rows.map((row) => <li key={row.action}>
        <span className="permission-label">{row.label}<span className="sub">{row.locked ?? counter(row)}{row.level === "auto" && row.limitEur ? ` · up to €${row.limitEur}` : ""}</span></span>
        <PermissionLevel action={row.action} label={row.label} level={row.level} limitEur={row.limitEur} costs={row.costs} locked={row.locked} />
      </li>)}
    </ul>
  </section>
}

export default async function Settings() {
  await connection()
  const [{ rows, changes }, at] = await Promise.all([permissions(), clockNow()])
  const now = at.toISOString()
  return <main className="content narrow">
    <div className="page-head"><div><h1>Settings</h1><p className="page-sub">What agents may do on their own, and what they learn from your corrections.</p></div></div>
    <SettingsNav current="permissions" />
    <p className="lead">Code checks this table before every action; the agents cannot change it. Reading, asking a driver or a site and looking things up need no approval. Anything that books, costs money, changes a date or contacts a customer asks you first, unless you let the agent do it here.</p>
    <section className="permission-group">
      <h2 className="section-title">Agents do these on their own</h2>
      <p className="note">They tell you on the order what they did.</p>
      <ul className="permissions">
        <li><span className="permission-label">{rows.filter((row) => row.always).map((row) => row.label).join(" · ")}<span className="sub">Always allowed: reading, asking and looking up change nothing, and routine answers come from the order&apos;s records.</span></span><span className="muted">Agent does it</span></li>
      </ul>
    </section>
    <Group title="" note="" rows={rows.filter((row) => row.level === "auto" && !row.always)} />
    <Group title="Agents ask you first" note="A card in For you, with the exact action, its cost and an 8-second undo after you approve." rows={rows.filter((row) => row.level === "approval")} />
    <Group title="Never" note="Agents cannot propose these." rows={rows.filter((row) => row.level === "never")} />
    <section className="permission-group">
      <h2 className="section-title">Changes</h2>
      {changes.length === 0 ? <p className="note">No changes yet. The table is as it shipped.</p> : <ul className="changes">
        {changes.map((change) => <li key={change.id}>
          <span className="entry-time"><When iso={change.at.toISOString()} now={now} zone={DESK_ZONE} /></span>
          <span><b>{change.label}</b>: {LEVEL_WORDS[change.fromLevel as keyof typeof LEVEL_WORDS] ?? change.fromLevel} → {LEVEL_WORDS[change.toLevel as keyof typeof LEVEL_WORDS] ?? change.toLevel}{change.limitEur ? ` up to €${change.limitEur}` : ""}<span className="sub"> · {change.actor} · {change.reason}</span></span>
        </li>)}
      </ul>}
    </section>
  </main>
}
