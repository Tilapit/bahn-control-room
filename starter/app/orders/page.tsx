import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { getCases, search } from "@/lib/case"
import { now as clockNow } from "@/lib/clock"
import { orderView } from "@/lib/queue"
import { liveSignals } from "@/lib/signals"
import { compareUrgency, urgency } from "@/lib/urgency"

export const metadata: Metadata = { title: "Orders" }

type Props = { searchParams: Promise<{ q?: string }> }

export default async function Orders({ searchParams }: Props) {
  await connection()
  const { q = "" } = await searchParams
  const query = q.trim()
  const at = await clockNow()
  const files = await getCases()
  const hits = query ? await search(query, 100) : null
  const byId = new Map(files.map((file) => [file.order.id, file]))
  const rows = (hits ? hits.map((hit) => ({ file: byId.get(hit.orderId)!, snippet: hit.snippet })) : files.map((file) => ({ file, snippet: null as string | null })))
    .filter((row) => !!row.file)
    .map((row) => ({ ...row, urgency: urgency(row.file, at), open: liveSignals(row.file).length }))
  if (!hits) rows.sort((a, b) => Number(b.open > 0) - Number(a.open > 0) || compareUrgency(a.urgency, b.urgency) || a.file.order.reference.localeCompare(b.file.order.reference))

  return <main className="content wide">
    <div className="page-head">
      <div>
        <h1>Orders</h1>
        <p className="page-sub">{hits ? <>{hits.length} order{hits.length === 1 ? "" : "s"} match “{query}”</> : <>All {files.length} orders. Orders with something open come first.</>}</p>
      </div>
      <form action="/orders" role="search" className="search" style={{ maxWidth: 360 }}>
        <label className="search-box"><span className="sr-only">Filter orders</span><input name="q" defaultValue={query} placeholder="Filter by reference, plate, name or city" /></label>
      </form>
    </div>
    {rows.length === 0 && <div className="empty"><h2>No order matches “{query}”.</h2><p>Search covers references, plates, VINs, cars, customers, drivers, cities and every message.</p></div>}
    {rows.length > 0 && <div className="list" role="list">
      {rows.map(({ file, snippet, urgency: u, open }) => {
        const view = orderView(file)
        return <Link className="list-row" role="listitem" href={`/orders/${file.order.reference}`} key={file.order.id}>
          <span className="ref"><span className={`mark ${u.safety && open ? "safety" : u.timeRisk && open ? "time" : open ? "" : "none"}`} aria-hidden="true" />{file.order.reference}</span>
          <span><span className="car">{file.order.car.label}</span><br /><span className="sub">{file.order.customer.name}</span></span>
          <span><span>{view.route}</span><br /><span className="sub">{file.order.stage.label}</span></span>
          <span className={open ? "" : "sub"}>{open ? u.sentence : "Nothing open"}</span>
          {snippet && <span className="snippet">“{snippet.replaceAll("«", "").replaceAll("»", "")}”</span>}
        </Link>
      })}
    </div>}
  </main>
}
