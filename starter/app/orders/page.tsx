import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { and, asc, eq, notInArray } from "drizzle-orm"
import { getCases, orderCount, search, type SearchHit } from "@/lib/case"
import { now as clockNow } from "@/lib/clock"
import { db } from "@/lib/db"
import { holdings, orderView } from "@/lib/queue"
import { orders } from "@/lib/schema"
import { liveSignals } from "@/lib/signals"
import { type Holder, listStatus, problemPhrase } from "@/lib/status"
import { compareUrgency, urgency, withProposalDeadline } from "@/lib/urgency"
import { Marked } from "../ui/marked"

export const metadata: Metadata = { title: "Orders" }

type Show = "you" | "agent" | "taken" | "quiet" | "delivered"
type Props = { searchParams: Promise<{ q?: string; show?: string; n?: string }> }

const CHIPS: { id: Show; label: string }[] = [
  { id: "you", label: "Needs you" }, { id: "agent", label: "Agent working" }, { id: "taken", label: "Taken over" },
  { id: "quiet", label: "Quiet" }, { id: "delivered", label: "Delivered" },
]
/** Rows per page of orders with nothing open: with 1,000 orders only the open ones and one page of the rest are compiled. */
const PAGE = 100
const WHO: Record<Holder, string> = { you: "You", agent: "Agent", nobody: "Nobody needed" }

export default async function Orders({ searchParams }: Props) {
  await connection()
  const params = await searchParams
  const query = (params.q ?? "").trim()
  const show = CHIPS.some((chip) => chip.id === params.show) ? params.show as Show : null
  const shown = Math.min(Math.max(Number(params.n) || PAGE, PAGE), 5000)
  const at = await clockNow()
  const [hits, held, deliveredRows, total] = await Promise.all([
    query ? search(query, 100) : null,
    // Who has each open order, by the same rules as For you's header.
    holdings(at),
    // A cheap first cut for the Delivered chip: the order record's status. The compiled case file still decides each row.
    db.select({ id: orders.id }).from(orders).where(eq(orders.status, "DELIVERED")),
    orderCount(),
  ])
  const takenOver = new Set<string>()
  const { cardOf, holding } = held

  // Who has each order, so the chips can count 1,000 orders while only the open ones are compiled.
  const open = new Set([...holding.keys(), ...takenOver])
  const delivered = new Set(deliveredRows.map((row) => row.id).filter((id) => !open.has(id)))
  const groupOf = (id: string): Show => takenOver.has(id) ? "taken" : holding.get(id) === "agent" ? "agent" : open.has(id) ? "you" : delivered.has(id) ? "delivered" : "quiet"
  const counts: Record<Show, number> = { you: 0, agent: 0, taken: 0, delivered: delivered.size, quiet: 0 }
  for (const id of open) counts[groupOf(id)] += 1
  counts.quiet = total - open.size - delivered.size

  // Compile only what is shown: the matches, one chip's orders, or every open order and one page of the rest.
  let ids: string[]
  if (hits) ids = hits.map((hit) => hit.orderId).filter((id) => !show || groupOf(id) === show)
  else if (show === "you" || show === "agent" || show === "taken") ids = [...open].filter((id) => groupOf(id) === show)
  else if (show === "delivered") ids = (await db.select({ id: orders.id }).from(orders).where(and(eq(orders.status, "DELIVERED"), open.size ? notInArray(orders.id, [...open]) : undefined)).orderBy(asc(orders.reference)).limit(shown)).map((row) => row.id)
  else {
    const exclude = show === "quiet" ? [...open, ...delivered] : [...open]
    const rest = (await db.select({ id: orders.id }).from(orders).where(exclude.length ? notInArray(orders.id, exclude) : undefined).orderBy(asc(orders.reference)).limit(shown)).map((row) => row.id)
    ids = show === "quiet" ? rest : [...open, ...rest]
  }
  const known = new Map(held.files.map((file) => [file.order.id, file]))
  const files = [...ids.filter((id) => known.has(id)).map((id) => known.get(id)!), ...await getCases(ids.filter((id) => !known.has(id)))]
  const snippets = new Map((hits ?? []).map((hit) => [hit.orderId, hit.snippet] as const))
  const rows = files.map((file) => {
    const id = file.order.id
    const card = cardOf.get(id) ?? null
    const primary = card?.options.find((option) => option.kind !== "reject" && option.kind !== "answer") ?? null
    const group = groupOf(id)
    const holder: Holder = group === "you" || group === "taken" ? "you" : group === "agent" ? "agent" : "nobody"
    const problem = problemPhrase(card?.headline ?? liveSignals(file)[0])
    return {
      file, card, holder, snippet: snippets.get(id) ?? null as SearchHit["snippet"],
      urgency: withProposalDeadline(urgency(file, at), primary, at), open: open.has(id),
      status: listStatus(file, { holder, problem: holder === "nobody" ? null : problem, takenOver: takenOver.has(id) }, at),
    }
  })
  // Filtered or not, the order is the same: open first, then what is lost first.
  rows.sort((a, b) => Number(b.open) - Number(a.open) || compareUrgency(a.urgency, b.urgency) || a.file.order.reference.localeCompare(b.file.order.reference))
  const paged = show === "quiet" || show === "delivered" || !show
  const pageTotal = show === "quiet" ? counts.quiet : show === "delivered" ? counts.delivered : total - open.size
  const shownRest = rows.filter((row) => !row.open).length
  const href = (next: { show?: Show | null; n?: number }) => {
    const search = new URLSearchParams()
    if (query) search.set("q", query)
    const chip = next.show === undefined ? show : next.show
    if (chip) search.set("show", chip)
    if (next.n) search.set("n", String(next.n))
    const text = search.toString()
    return text ? `/orders?${text}` : "/orders"
  }

  return <main className="content wide">
    <div className="page-head">
      <div>
        <h1>Orders</h1>
        <p className="page-sub">{hits ? <>{rows.length} order{rows.length === 1 ? "" : "s"} match “{query}”</> : <>All {total.toLocaleString("en-GB")} orders, open ones first, then what is lost first</>}</p>
      </div>
      <form action="/orders" role="search" className="search" style={{ maxWidth: 360 }}>
        {show && <input type="hidden" name="show" value={show} />}
        <label className="search-box"><span className="sr-only">Search orders</span><input name="q" defaultValue={query} placeholder="Search: reference, plate, name, city or any word" />
          {query && <Link className="clear" href={show ? `/orders?show=${show}` : "/orders"} aria-label="Clear the search">Clear</Link>}</label>
      </form>
    </div>
    <nav className="filters" aria-label="Show orders">
      <Link className="filter" href={href({ show: null })} aria-current={!show ? "true" : undefined}>All <span className="n">{total.toLocaleString("en-GB")}</span></Link>
      {CHIPS.map((chip) => <Link key={chip.id} className="filter" href={href({ show: chip.id })} aria-current={show === chip.id ? "true" : undefined}>
        {chip.label} <span className="n">{counts[chip.id].toLocaleString("en-GB")}</span>
      </Link>)}
    </nav>
    {rows.length === 0 && <div className="empty">
      <h2>{query ? `No order matches “${query}”${show ? " in this filter" : ""}.` : "No orders here right now."}</h2>
      <p>{query ? "Search covers references, plates, VINs, cars, customers, drivers, cities and every record on an order." : "Pick another filter, or All."}</p>
    </div>}
    {rows.length > 0 && <div className="orders-table" role="table" aria-label="Orders">
      <div className="ot-row ot-head" role="row">
        {["Car", "Reference", "Route", "Customer", "Status", "Who has it"].map((label) => <span role="columnheader" key={label}>{label}</span>)}
      </div>
      {rows.map(({ file, snippet, urgency: u, open: isOpen, holder, status }) => {
        const tone = isOpen && u.safety ? "safety" : isOpen && u.timeRisk ? "time" : ""
        return <Link className="ot-row" role="row" href={`/orders/${file.order.reference}`} key={file.order.id}>
          <span role="cell" className="ot-car" title={file.order.car.label}><span className={`mark ${tone || (isOpen ? "" : "none")}`} aria-hidden="true" />{file.order.car.label}</span>
          <span role="cell" className="ot-ref">{file.order.reference}</span>
          <span role="cell" title={orderView(file).route}>{orderView(file).route}</span>
          <span role="cell" title={file.order.customer.name}>{file.order.customer.name}</span>
          <span role="cell" className="ot-status" title={isOpen && u.relative ? `${status}. ${u.sentence}, ${u.relative}` : status}>
            <span className="ot-text">{status}</span>{isOpen && u.relative && <span className={`when ${tone}`}>{u.relative}</span>}
          </span>
          <span role="cell" className={`ot-who ${holder}`}>{WHO[holder]}</span>
          {snippet && <span className="ot-snippet">{snippet.source} · {snippet.when}: “<Marked text={snippet.text} />”</span>}
        </Link>
      })}
    </div>}
    {!hits && paged && pageTotal > shownRest && <p className="queue-end">
      Showing {shownRest.toLocaleString("en-GB")} of {pageTotal.toLocaleString("en-GB")} {show === "delivered" ? "delivered orders" : "orders with nothing open"}. <Link className="link" href={href({ n: shown + PAGE })}>Show {PAGE} more</Link>
    </p>}
  </main>
}
