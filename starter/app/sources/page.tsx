import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { sql } from "drizzle-orm"
import { now as clockNow } from "@/lib/clock"
import { db } from "@/lib/db"
import { SOURCE_KINDS } from "@/lib/sources"
import { dayClockZone, relative } from "@/lib/time"
import { Icon } from "../ui/icons"

export const metadata: Metadata = { title: "Sources" }

const DESK = "Europe/Helsinki"
type Props = { searchParams: Promise<{ source?: string }> }
type Row = { source: string; n: number; orders: number; latest: string | null }
type Entry = { id: string; reference: string | null; at: string; author: string | null; summary: string; status: string | null }

export default async function Sources({ searchParams }: Props) {
  await connection()
  const { source: chosen } = await searchParams
  const now = await clockNow()
  const kind = SOURCE_KINDS.find((item) => item.key === chosen) ?? null
  const list = (values: string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `)
  const [rows, factRows, latest] = await Promise.all([
    db.execute<Row>(sql`select source, count(*)::int as n, count(distinct order_id)::int as orders, max(occurred_at) as latest from timeline_entries group by source`),
    db.execute<{ kind: string; n: number; orders: number }>(sql`select kind, count(*)::int as n, count(distinct order_id)::int as orders from facts where origin = 'classifier' and status <> 'superseded' group by kind`),
    kind ? db.execute<Entry>(sql`select t.id, o.reference, t.occurred_at as at, t.author_label as author, t.summary, t.status from timeline_entries t left join orders o on o.id = t.order_id
      where t.source in (${list(kind.sources)}) order by t.occurred_at desc, t.id limit 50`) : Promise.resolve([] as Entry[]),
  ])
  const bySource = new Map([...rows].map((row) => [row.source, row]))
  const stats = SOURCE_KINDS.map((item) => {
    const parts = item.sources.map((source) => bySource.get(source)).filter((row): row is Row => !!row)
    return {
      ...item, records: parts.reduce((sum, row) => sum + row.n, 0), orders: parts.reduce((sum, row) => Math.max(sum, row.orders), 0),
      latest: parts.map((row) => row.latest).filter((value): value is string => !!value).sort().pop() ?? null,
    }
  })
  const facts = [...factRows]
  const factCount = facts.find((row) => row.kind === "fact")?.n ?? 0
  const agreementCount = facts.find((row) => row.kind === "agreement")?.n ?? 0
  const [factOrders] = await db.execute<{ n: number }>(sql`select count(distinct order_id)::int as n from facts where origin = 'classifier' and status <> 'superseded'`)

  return <main className="content wide">
    <div className="page-head">
      <div>
        <h1>Sources</h1>
        <p className="page-sub">Everything any channel says about an order lands on that order&apos;s one timeline. This is where it comes from.</p>
        <p className="page-explain">The Classifier read every message and wrote down <b>{factCount.toLocaleString("en-GB")} facts</b> and <b>{agreementCount.toLocaleString("en-GB")} agreements</b> across {(factOrders?.n ?? 0).toLocaleString("en-GB")} orders, each marked as said, not confirmed, with the message it came from.</p>
      </div>
    </div>
    <div className="src-table" role="table" aria-label="Sources">
      <div className="src-row src-head" role="row">
        {["Source", "Records", "Orders", "Latest", "In production"].map((label) => <span role="columnheader" key={label}>{label}</span>)}
      </div>
      {stats.map((item) => <Link role="row" className="src-row" key={item.key} href={item.key === kind?.key ? "/sources" : `/sources?source=${item.key}`} aria-current={item.key === kind?.key ? "true" : undefined}>
        <span role="cell" className="src-name"><Icon name={item.icon} />{item.label}</span>
        <span role="cell" className="num">{item.records.toLocaleString("en-GB")}</span>
        <span role="cell" className="num">{item.orders.toLocaleString("en-GB")}</span>
        <span role="cell" title={item.latest ? dayClockZone(item.latest, now, DESK) : undefined}>{item.latest ? relative(item.latest, now) : "none yet"}</span>
        <span role="cell" className="muted">{item.production}</span>
      </Link>)}
    </div>
    {kind && <section className="src-latest" aria-label={`Latest from ${kind.label}`}>
      <h2 className="section-label"><Icon name={kind.icon} /> Latest {latest.length} from {kind.label}</h2>
      {latest.length === 0 && <p className="note">Nothing from this source yet.</p>}
      <ul className="src-entries">
        {[...latest].map((entry) => <li key={entry.id}>
          <span className="src-when" title={dayClockZone(entry.at, now, DESK)}>{relative(entry.at, now)}</span>
          {entry.reference ? <Link className="src-ref" href={`/orders/${entry.reference}#${entry.id}`}>{entry.reference}</Link> : <span className="src-ref faint">no order</span>}
          <span className="src-text"><b>{entry.author ?? kind.label}</b> {entry.summary}</span>
        </li>)}
      </ul>
    </section>}
    <p className="queue-end">Times are relative to the demo clock; hover for the date and time in Helsinki.</p>
  </main>
}
