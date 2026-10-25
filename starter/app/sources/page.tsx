import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { sql } from "drizzle-orm"
import { now as clockNow } from "@/lib/clock"
import { db } from "@/lib/db"
import { SOURCE_KINDS, type SourceKind } from "@/lib/sources"
import { dayClockZone, relative } from "@/lib/time"
import { Icon } from "../ui/icons"
import "./sources.css"

export const metadata: Metadata = { title: "Sources" }

const DESK = "Europe/Helsinki"
type Props = { searchParams: Promise<{ source?: string }> }
type Row = { source: string; n: number; orders: number; latest: string | null }
type Entry = { id: string; reference: string | null; at: string; author: string | null; summary: string; status: string | null }

/** What each source is in this demo's records, in one muted line under its name. */
const ABOUT: Record<string, string> = {
  driver: "What drivers wrote in the driver app chat, WhatsApp and app messages",
  support: "Customers' and sites' messages in support chat, one record per message",
  internal: "Internal notes and operators' notes on the order",
  email: "Emails from customers and the shared mailbox",
  calls: "Calls with sites, written down",
  gps: "Tracking: km to go, progress and an ETA from the driver app; no map position",
  bookings: "Ferry, train, flight and hotel bookings, confirmed by the provider",
  quotes: "Prices and availability checks, not booked",
  alerts: "Monitoring alerts and disruption notices: a reason to look, not a diagnosis",
  agents: "Every step this control room's agents took on an order",
  people: "Decisions, takeovers and notes by people here",
  records: "The order itself: time windows, handover details, documents and proofs",
}

/** The four groups, each with the rule the agents and the screens follow for it. */
const GROUPS: { id: string; title: string; rule: string; keys: string[] }[] = [
  { id: "people-say", title: "What people say", rule: "Messages are treated as statements: “the driver says”, never proof on their own.", keys: ["driver", "support", "internal", "email", "calls"] },
  { id: "cars", title: "Where the cars are", rule: "An old position is shown as old, not as where the car is now.", keys: ["gps"] },
  { id: "bookings", title: "Bookings, quotes and alerts", rule: "A quote is a price, not a booking. A booking is a plan, not proof the car moved.", keys: ["bookings", "quotes", "alerts"] },
  { id: "control-room", title: "Inside the control room", rule: "What agents and people did here, and Bahn's own order records.", keys: ["agents", "people", "records"] },
]

/** Within the last hour: the Latest time is shown in the accent colour, as something live. */
const RECENT_MINUTES = 60

export default async function Sources({ searchParams }: Props) {
  await connection()
  const { source: chosen } = await searchParams
  const now = await clockNow()
  const kind = SOURCE_KINDS.find((item) => item.key === chosen) ?? null
  const list = (values: string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `)
  const [rows, factRows, latest, factOrderRows] = await Promise.all([
    db.execute<Row>(sql`select source, count(*)::int as n, count(distinct order_id)::int as orders, max(occurred_at) as latest from timeline_entries group by source`),
    db.execute<{ kind: string; n: number }>(sql`select kind, count(*)::int as n from facts where origin = 'classifier' and status <> 'superseded' group by kind`),
    kind ? db.execute<Entry>(sql`select t.id, o.reference, t.occurred_at as at, t.author_label as author, t.summary, t.status from timeline_entries t left join orders o on o.id = t.order_id
      where t.source in (${list(kind.sources)}) order by t.occurred_at desc, t.id limit 50`) : Promise.resolve([] as Entry[]),
    db.execute<{ n: number }>(sql`select count(distinct order_id)::int as n from facts where origin = 'classifier' and status <> 'superseded'`),
  ])
  const bySource = new Map([...rows].map((row) => [row.source, row]))
  const stats = new Map(SOURCE_KINDS.map((item) => {
    const parts = item.sources.map((source) => bySource.get(source)).filter((row): row is Row => !!row)
    return [item.key, {
      ...item, records: parts.reduce((sum, row) => sum + row.n, 0), orders: parts.reduce((sum, row) => Math.max(sum, row.orders), 0),
      latest: parts.map((row) => row.latest).filter((value): value is string => !!value).map((value) => new Date(value).toISOString()).sort().pop() ?? null,
    }]
  }))
  const facts = [...factRows]
  const factCount = facts.find((row) => row.kind === "fact")?.n ?? 0
  const agreementCount = facts.find((row) => row.kind === "agreement")?.n ?? 0
  const factOrders = [...factOrderRows][0]?.n ?? 0
  const number = (value: number) => value.toLocaleString("en-GB")

  return <main className="content narrow srcs" id="top">
    <div className="page-head">
      <div>
        <h1>Sources</h1>
        <p className="page-sub">Everything any channel says about an order lands on that order&apos;s one timeline. This is where it comes from.</p>
      </div>
    </div>
    <nav className="srcs-jump" aria-label="Groups">
      {GROUPS.map((group) => <a key={group.id} className="srcs-chip" href={`#${group.id}`}>{group.title}</a>)}
    </nav>

    <div className="srcs-info" role="note">
      <svg className="srcs-info-icon" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M9 8v4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><circle cx="9" cy="5.6" r="0.9" fill="currentColor" /></svg>
      <p>The Classifier read every message and wrote down <b>{number(factCount)} {factCount === 1 ? "fact" : "facts"}</b> and <b>{number(agreementCount)} {agreementCount === 1 ? "agreement" : "agreements"}</b> across {number(factOrders)} {factOrders === 1 ? "order" : "orders"}.
        Each one is marked as <i>said</i>, not confirmed, and links back to the message it came from.</p>
    </div>

    {GROUPS.map((group) => {
      const items = group.keys.map((key) => stats.get(key)).filter((item): item is SourceKind & { records: number; orders: number; latest: string | null } => !!item)
      const open = kind && group.keys.includes(kind.key) ? kind : null
      return <section className="srcs-group" id={group.id} key={group.id} aria-labelledby={`${group.id}-title`}>
        <h2 id={`${group.id}-title`}>{group.title}</h2>
        <p className="srcs-rule">{group.rule}</p>
        <div className="srcs-card" role="table" aria-label={group.title}>
          <div className="srcs-row srcs-head" role="row">
            <span role="columnheader">Source</span>
            <span role="columnheader" className="num">Records</span>
            <span role="columnheader" className="num">Orders</span>
            <span role="columnheader" className="num">Latest</span>
          </div>
          {items.map((item) => {
            const minutes = item.latest ? (now.getTime() - new Date(item.latest).getTime()) / 60000 : null
            const recent = minutes != null && minutes >= -1 && minutes < RECENT_MINUTES
            return <Link role="row" className="srcs-row" key={item.key} href={item.key === kind?.key ? `/sources#${group.id}` : `/sources?source=${item.key}#${group.id}`}
              aria-current={item.key === kind?.key ? "true" : undefined} title={`Show the latest records from ${item.label}`}>
              <span role="cell" className="srcs-source">
                <span className="srcs-name"><Icon name={item.icon} size={14} />{item.label}</span>
                <span className="srcs-about">{ABOUT[item.key]}</span>
                <span className="srcs-prod">In production: {item.production}</span>
              </span>
              <span role="cell" className="num">{number(item.records)}</span>
              <span role="cell" className="num">{item.records ? number(item.orders) : "—"}</span>
              <span role="cell" className={`num srcs-latest${recent ? " recent" : ""}`} title={item.latest ? dayClockZone(item.latest, now, DESK) : undefined}>{item.latest ? relative(item.latest, now) : "—"}</span>
            </Link>
          })}
        </div>
        {open && <div className="srcs-entries-box" aria-label={`Latest from ${open.label}`}>
          <h3 className="section-label"><Icon name={open.icon} size={14} /> Latest {[...latest].length} from {open.label}</h3>
          {[...latest].length === 0 && <p className="note">Nothing from this source yet.</p>}
          <ul className="src-entries">
            {[...latest].map((entry) => <li key={entry.id}>
              <span className="src-when" title={dayClockZone(entry.at, now, DESK)}>{relative(entry.at, now)}</span>
              {entry.reference ? <Link className="src-ref" href={`/orders/${entry.reference}#${entry.id}`}>{entry.reference}</Link> : <span className="src-ref faint">no order</span>}
              <span className="src-text"><b>{entry.author ?? open.label}</b> {entry.summary}</span>
            </li>)}
          </ul>
        </div>}
      </section>
    })}

    <footer className="srcs-foot">
      <p>Times are relative to now. Hover a time for the exact date and time in Helsinki.</p>
      <a href="#top">Back to top ↑</a>
    </footer>
  </main>
}
