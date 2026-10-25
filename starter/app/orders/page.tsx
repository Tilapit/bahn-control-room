import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { and, asc, eq, gt, inArray, notInArray, or } from "drizzle-orm"
import { getCases, orderCount, ordersWithOpenItems, search, type SearchHit } from "@/lib/case"
import { now as clockNow } from "@/lib/clock"
import { db } from "@/lib/db"
import { orderView } from "@/lib/queue"
import { quietLine } from "@/lib/quiet-check"
import { agentRuns, cards, orders } from "@/lib/schema"
import { liveSignals } from "@/lib/signals"
import { compareUrgency, urgency, withProposalDeadline } from "@/lib/urgency"
import { Marked } from "../ui/marked"

export const metadata: Metadata = { title: "Orders" }

type Props = { searchParams: Promise<{ q?: string; quiet?: string }> }

/** Quiet orders shown per page: with 1,000 orders only the open ones and a page of quiet ones are compiled. */
const QUIET_PAGE = 100

export default async function Orders({ searchParams }: Props) {
  await connection()
  const { q = "", quiet: quietParam } = await searchParams
  const query = q.trim()
  const quietShown = Math.min(Math.max(Number(quietParam) || QUIET_PAGE, QUIET_PAGE), 5000)
  const at = await clockNow()
  const [hits, openCards, agentWork, openIds, total] = await Promise.all([
    query ? search(query, 100) : null,
    db.select({ orderId: cards.orderId, group: cards.group, headline: cards.headline, options: cards.options }).from(cards).where(eq(cards.status, "open")),
    // An agent on the order: working, waiting for a driver or site, or finished and looking again later.
    db.select({ orderId: agentRuns.orderId }).from(agentRuns).where(and(inArray(agentRuns.agent, ["Investigator", "Driver support"]),
      or(inArray(agentRuns.status, ["running", "waiting_driver", "waiting_site"]), and(eq(agentRuns.status, "done"), gt(agentRuns.nextCheckAt, at))))),
    ordersWithOpenItems(),
    orderCount(),
  ])
  // Open means a card waiting for a person, a live signal, or an agent still on it: the same orders For you counts.
  const cardOf = new Map(openCards.flatMap((row) => [row.orderId, ...(row.group ?? []).map((member) => member.order_id)].map((id) => [id, row] as const)))
  const agentOn = new Set(agentWork.map((row) => row.orderId).filter((id): id is string => !!id))
  // Compile only what is shown: the matches, or every order with something open and one page of quiet ones.
  const open = new Set([...openIds, ...cardOf.keys(), ...agentOn])
  const quietIds = hits ? [] : (await db.select({ id: orders.id }).from(orders)
    .where(open.size ? notInArray(orders.id, [...open]) : undefined).orderBy(asc(orders.reference)).limit(quietShown)).map((row) => row.id)
  const files = await getCases(hits ? hits.map((hit) => hit.orderId) : [...open, ...quietIds])
  const quietTotal = hits ? 0 : total - open.size
  const byId = new Map(files.map((file) => [file.order.id, file]))
  const rows = (hits ? hits.map((hit) => ({ file: byId.get(hit.orderId)!, snippet: hit.snippet })) : files.map((file) => ({ file, snippet: null as SearchHit["snippet"] })))
    .filter((row) => !!row.file)
    .map((row) => {
      const card = cardOf.get(row.file.order.id) ?? null
      const primary = card?.options.find((option) => option.kind !== "reject" && option.kind !== "answer") ?? null
      return { ...row, card, urgency: withProposalDeadline(urgency(row.file, at), primary, at), open: !!card || agentOn.has(row.file.order.id) || liveSignals(row.file).length > 0 }
    })
  // Filtered or not, the order is the same: open first, then what is lost first.
  rows.sort((a, b) => Number(b.open) - Number(a.open) || compareUrgency(a.urgency, b.urgency) || a.file.order.reference.localeCompare(b.file.order.reference))

  return <main className="content wide">
    <div className="page-head">
      <div>
        <h1>Orders</h1>
        <p className="page-sub">{hits ? <>{hits.length} order{hits.length === 1 ? "" : "s"} match “{query}”</> : <>All {total.toLocaleString("en-GB")} orders, open ones first: <span className="legend"><span className="mark safety" />safety <span className="mark time" />lost within 4 hours or already missed <span className="mark" />later</span></>}</p>
      </div>
      <form action="/orders" role="search" className="search" style={{ maxWidth: 360 }}>
        <label className="search-box"><span className="sr-only">Filter orders</span><input name="q" defaultValue={query} placeholder="Filter: reference, name, city or any word" />
          {query && <Link className="clear" href="/orders" aria-label="Clear the filter">Clear</Link>}</label>
      </form>
    </div>
    {rows.length === 0 && <div className="empty"><h2>No order matches “{query}”.</h2><p>Search covers references, plates, VINs, cars, customers, drivers, cities and every message.</p></div>}
    {rows.length > 0 && <div className="list" role="list">
      <div className="list-row list-head" aria-hidden="true"><span>Order</span><span>Car and customer</span><span>Route and stage</span><span>What is open, and when</span></div>
      {rows.map(({ file, snippet, urgency: u, open, card }) => {
        const view = orderView(file)
        const tone = u.safety ? "safety" : u.timeRisk ? "time" : ""
        // Who is on it, and what the problem is: the card's headline without the car, or the first open item.
        const who = card ? "Needs you" : agentOn.has(file.order.id) ? "Agent on it" : null
        const problem = card ? card.headline.replace(/^[^:]{2,60}:\s*/, "").replace(/^./, (c) => c.toUpperCase()) : liveSignals(file)[0]?.replace(/^./, (c) => c.toUpperCase()) ?? null
        // A quiet order's line without the stage the column next to it already shows.
        const quiet = quietLine(file, at).replace(/^Nothing open\.\s*/, "")
        const quietNext = quiet.includes("; ") ? quiet.slice(quiet.indexOf("; ") + 2) : quiet
        return <Link className="list-row" role="listitem" href={`/orders/${file.order.reference}`} key={file.order.id}>
          <span className="ref"><span className={`mark ${u.safety && open ? "safety" : u.timeRisk && open ? "time" : open ? "" : "none"}`} aria-hidden="true" />{file.order.reference}</span>
          <span><span className="car">{file.order.car.label}</span><br /><span className="sub">{file.order.customer.name}</span></span>
          <span><span>{view.route}</span><br /><span className="sub">{file.order.stage.label}</span></span>
          {open ? <span>
            {(who || problem) && <span className="list-problem">{who && <b className={`who${card ? " you" : ""}`}>{who}</b>}{problem}</span>}
            <span className="sub">{u.sentence}{u.relative && <span className={`when ${tone} nowrap`}>, {u.relative}</span>}</span>
          </span> : <span className="sub">Nothing open: {quietNext.replace(/^./, (c) => c.toLowerCase())}</span>}
          {snippet && <span className="snippet">{snippet.source} · {snippet.when}: “<Marked text={snippet.text} />”</span>}
        </Link>
      })}
    </div>}
    {!hits && quietTotal > quietShown && <p className="queue-end">
      Showing {quietShown.toLocaleString("en-GB")} of {quietTotal.toLocaleString("en-GB")} orders with nothing open. <Link className="link" href={`/orders?quiet=${quietShown + QUIET_PAGE}`}>Show {QUIET_PAGE} more</Link>
    </p>}
  </main>
}
