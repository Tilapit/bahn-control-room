import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { eq } from "drizzle-orm"
import { getCases, search, type SearchHit } from "@/lib/case"
import { now as clockNow } from "@/lib/clock"
import { db } from "@/lib/db"
import { orderView } from "@/lib/queue"
import { quietLine } from "@/lib/quiet-check"
import { cards } from "@/lib/schema"
import { liveSignals } from "@/lib/signals"
import { compareUrgency, urgency } from "@/lib/urgency"
import { Marked } from "../ui/marked"

export const metadata: Metadata = { title: "Orders" }

type Props = { searchParams: Promise<{ q?: string }> }

export default async function Orders({ searchParams }: Props) {
  await connection()
  const { q = "" } = await searchParams
  const query = q.trim()
  const at = await clockNow()
  const [files, hits, openCards] = await Promise.all([
    getCases(),
    query ? search(query, 100) : null,
    db.select({ orderId: cards.orderId, group: cards.group }).from(cards).where(eq(cards.status, "open")),
  ])
  // Open means a live signal or a card waiting for a person, the same as on For you.
  const withCard = new Set(openCards.flatMap((row) => [row.orderId, ...(row.group ?? []).map((member) => member.order_id)]))
  const byId = new Map(files.map((file) => [file.order.id, file]))
  const rows = (hits ? hits.map((hit) => ({ file: byId.get(hit.orderId)!, snippet: hit.snippet })) : files.map((file) => ({ file, snippet: null as SearchHit["snippet"] })))
    .filter((row) => !!row.file)
    .map((row) => ({ ...row, urgency: urgency(row.file, at), open: withCard.has(row.file.order.id) || liveSignals(row.file).length > 0 }))
  // Filtered or not, the order is the same: open first, then what is lost first.
  rows.sort((a, b) => Number(b.open) - Number(a.open) || compareUrgency(a.urgency, b.urgency) || a.file.order.reference.localeCompare(b.file.order.reference))

  return <main className="content wide">
    <div className="page-head">
      <div>
        <h1>Orders</h1>
        <p className="page-sub">{hits ? <>{hits.length} order{hits.length === 1 ? "" : "s"} match “{query}”</> : <>All {files.length} orders. Orders with something open come first: <span className="legend"><span className="mark safety" />safety <span className="mark time" />time at risk <span className="mark" />open</span></>}</p>
      </div>
      <form action="/orders" role="search" className="search" style={{ maxWidth: 360 }}>
        <label className="search-box"><span className="sr-only">Filter orders</span><input name="q" defaultValue={query} placeholder="Filter by reference, plate, name or city" /></label>
      </form>
    </div>
    {rows.length === 0 && <div className="empty"><h2>No order matches “{query}”.</h2><p>Search covers references, plates, VINs, cars, customers, drivers, cities and every message.</p></div>}
    {rows.length > 0 && <div className="list" role="list">
      <div className="list-row list-head" aria-hidden="true"><span>Order</span><span>Car and customer</span><span>Route and stage</span><span>Next</span></div>
      {rows.map(({ file, snippet, urgency: u, open }) => {
        const view = orderView(file)
        return <Link className="list-row" role="listitem" href={`/orders/${file.order.reference}`} key={file.order.id}>
          <span className="ref"><span className={`mark ${u.safety && open ? "safety" : u.timeRisk && open ? "time" : open ? "" : "none"}`} aria-hidden="true" />{file.order.reference}</span>
          <span><span className="car">{file.order.car.label}</span><br /><span className="sub">{file.order.customer.name}</span></span>
          <span><span>{view.route}</span><br /><span className="sub">{file.order.stage.label}</span></span>
          <span className={open ? "" : "sub"}>{open ? `${u.sentence}${u.relative ? `, ${u.relative}` : ""}` : quietLine(file, at)}</span>
          {snippet && <span className="snippet">{snippet.source} · {snippet.when}: “<Marked text={snippet.text} />”</span>}
        </Link>
      })}
    </div>}
  </main>
}
