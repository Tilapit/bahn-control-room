import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { getCases, search, type StageKey } from "@/lib/case"
import { now as clockNow } from "@/lib/clock"
import { holdings, orderView } from "@/lib/queue"
import { liveSignals } from "@/lib/signals"
import { type Holder, listStatus, problemPhrase } from "@/lib/status"
import { openTakeovers } from "@/lib/takeover"
import { orderRoutes, teamOf } from "@/lib/team-data"
import { compareUrgency, urgency, withProposalDeadline } from "@/lib/urgency"
import { ViewSwitcher } from "../ui/view-switcher"
import { type OrderRow, OrdersTable, StageSelect } from "./orders-table"
import "./orders.css"

export const metadata: Metadata = { title: "Orders" }

type Show = "you" | "agent" | "taken" | "quiet" | "delivered"
type Props = { searchParams: Promise<{ q?: string; show?: string; stage?: string }> }

const CHIPS: { id: Show; label: string }[] = [
  { id: "you", label: "Needs you" }, { id: "agent", label: "Agent working" }, { id: "taken", label: "Taken over" },
  { id: "quiet", label: "Quiet" }, { id: "delivered", label: "Delivered today" },
]

/** The stage in a word or two, for the table and the stage menu; the order page keeps the full sentence. */
const STAGE_WORDS: Record<StageKey, string> = {
  intake: "New", ready: "Ready", finding_driver: "Finding a driver", driver_booked: "Driver booked",
  moving: "Moving", at_transfer: "At the transfer yard", delivered: "Delivered", cancelled: "Cancelled",
}
const STAGES = Object.keys(STAGE_WORDS) as StageKey[]

/** The desk reads days in Helsinki time, like the clock in the top bar. */
const DESK = "Europe/Helsinki"
const dayOf = (value: string | Date) => new Intl.DateTimeFormat("en-CA", { timeZone: DESK }).format(new Date(value))

/** "AL" for "Anna L.": a colleague's initials for the Who column. */
const initials = (name: string) => name.split(/\s+/).map((part) => part.charAt(0)).join("").slice(0, 2).toUpperCase()

export default async function Orders({ searchParams }: Props) {
  await connection()
  const params = await searchParams
  const query = (params.q ?? "").trim()
  const show = CHIPS.some((chip) => chip.id === params.show) ? params.show as Show : null
  const stage = STAGES.includes(params.stage as StageKey) ? params.stage as StageKey : null
  const at = await clockNow()
  // Every order is compiled (about 0.3 s for 1,000): stages, deadlines and who has it come from the records, not a lane field.
  const [files, held, taken, hits] = await Promise.all([getCases(), holdings(at), openTakeovers(), query ? search(query, 200) : null])
  const { cardOf, holding } = held
  const holderOf = new Map(taken.map((row) => [row.orderId, row.takenBy]))
  const today = dayOf(at)

  const groupOf = (id: string, deliveredAt: string | null): Show => {
    const kind = holding.get(id)
    if (holderOf.has(id) || kind === "taken") return "taken"
    if (kind === "agent") return "agent"
    if (kind) return "you"
    return deliveredAt && dayOf(deliveredAt) === today ? "delivered" : "quiet"
  }
  const counts: Record<Show, number> = { you: 0, agent: 0, taken: 0, quiet: 0, delivered: 0 }
  const stageCounts = new Map<StageKey, number>()
  for (const file of files) {
    counts[groupOf(file.order.id, file.order.deliveredAt)] += 1
    stageCounts.set(file.order.stage.key, (stageCounts.get(file.order.stage.key) ?? 0) + 1)
  }

  const matched = hits ? new Map(hits.map((hit) => [hit.orderId, hit.snippet] as const)) : null
  const chosen = files.filter((file) => (!matched || matched.has(file.order.id))
    && (!stage || file.order.stage.key === stage)
    && (!show || groupOf(file.order.id, file.order.deliveredAt) === show))
  const routes = await orderRoutes(chosen.map((file) => file.order.id))

  const built = chosen.map((file) => {
    const id = file.order.id
    const card = cardOf.get(id) ?? null
    const primary = card?.options.find((option) => option.kind !== "reject" && option.kind !== "answer") ?? null
    const group = groupOf(id, file.order.deliveredAt)
    const open = group === "you" || group === "agent" || group === "taken"
    const u = withProposalDeadline(urgency(file, at), primary, at)
    const holder: Holder = group === "you" || group === "taken" ? "you" : group === "agent" ? "agent" : "nobody"
    const problem = problemPhrase(card?.headline ?? liveSignals(file)[0])
    const takenBy = holderOf.get(id) ?? null
    const finished = file.order.stage.key === "delivered" || file.order.stage.key === "cancelled"
    // A deadline that is real and still ahead; a closed order's past promise is not news.
    const due = open ? u.relative : !finished && u.at && u.kind !== "alert_followup" && u.relative.startsWith("in ") ? u.relative : ""
    const tone = open && u.safety ? "safety" : open && u.timeRisk ? "time" : ""
    const who: OrderRow["who"] = takenBy
      ? takenBy === "Ops" ? { kind: "you", label: "You", initials: "Y", title: "You took this order over; agents leave it alone until you hand it back" }
        : { kind: "colleague", label: takenBy, initials: initials(takenBy), title: `${takenBy} took this order over; agents leave it alone until it is handed back` }
      : group === "you" ? { kind: "unclaimed", label: "Unclaimed", initials: "", title: "Something waits for a person and nobody has taken it" }
      : group === "agent" ? { kind: "agent", label: "Agent", initials: "", title: "An agent works on it or looks again later" }
      : { kind: "quiet", label: "", initials: "", title: "Nothing is open on it" }
    const row: OrderRow = {
      id, reference: file.order.reference, car: file.order.car.label, route: orderView(file).route,
      stage: STAGE_WORDS[file.order.stage.key], stageTitle: file.order.stage.label,
      status: listStatus(file, { holder, problem: holder === "nobody" ? null : problem, takenOver: !!takenBy || group === "taken", takenBy: takenBy ?? null }, at),
      due, dueTitle: open && u.relative ? `${u.sentence}, ${u.relative}` : due ? u.sentence : "",
      tone, dot: u.safety && open ? "safety" : u.timeRisk && open ? "time" : group === "agent" ? "agent" : open ? "open" : "none",
      who, team: teamOf(routes.get(id), card, file), snippet: matched?.get(id) ?? null,
    }
    return { row, open, urgency: u }
  })
  // Open ones first, then whatever is due soonest; no deadline last.
  built.sort((a, b) => Number(b.open) - Number(a.open) || compareUrgency(a.urgency, b.urgency) || a.row.reference.localeCompare(b.row.reference))
  const rows = built.map((item) => item.row)

  const href = (next: { show?: Show | null }) => {
    const search = new URLSearchParams()
    if (query) search.set("q", query)
    if (stage) search.set("stage", stage)
    const chip = next.show === undefined ? show : next.show
    if (chip) search.set("show", chip)
    const text = search.toString()
    return text ? `/orders?${text}` : "/orders"
  }
  const filtered = !!(query || stage)
  const total = files.length

  return <main className="content wide orders-page">
    <div className="page-head">
      <div>
        <h1>Orders</h1>
        <p className="page-sub">All {total.toLocaleString("en-GB")} orders. Open ones first, then whatever is due soonest.</p>
      </div>
    </div>
    <form action="/orders" role="search" className="o-search">
      {show && <input type="hidden" name="show" value={show} />}
      <label className="o-search-box">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
        <span className="sr-only">Search orders</span>
        <input name="q" defaultValue={query} placeholder="Search car, order, customer, city, or any word said on an order" />
      </label>
      <StageSelect value={stage ?? ""} total={total} options={STAGES.filter((key) => stageCounts.get(key)).map((key) => ({ value: key, label: STAGE_WORDS[key], count: stageCounts.get(key) ?? 0 }))} />
    </form>
    <div className="o-chips-row">
      <nav className="filters" aria-label="Show orders">
        <Link className="filter" href={href({ show: null })} aria-current={!show ? "true" : undefined}>All <span className="n">{total.toLocaleString("en-GB")}</span></Link>
        {CHIPS.map((chip) => <Link key={chip.id} className="filter" href={href({ show: chip.id })} aria-current={show === chip.id ? "true" : undefined}>
          {chip.label} <span className="n">{counts[chip.id].toLocaleString("en-GB")}</span>
        </Link>)}
      </nav>
      <ViewSwitcher />
    </div>
    {filtered && <p className="o-match">
      {rows.length.toLocaleString("en-GB")} order{rows.length === 1 ? "" : "s"} match{rows.length === 1 ? "es" : ""}
      {query && <> “{query}”</>}{stage && <> · stage {STAGE_WORDS[stage]}</>}
      <Link className="link" href={show ? `/orders?show=${show}` : "/orders"}>Clear search</Link>
    </p>}
    {rows.length === 0
      ? <div className="empty">
        <h2>{query ? `No order matches “${query}”${show || stage ? " in this filter" : ""}.` : "No orders here right now."}</h2>
        <p>{query ? "Search covers references, plates, VINs, cars, customers, drivers, cities and every record on an order." : "Pick another filter, or All."}</p>
      </div>
      : <OrdersTable rows={rows} />}
  </main>
}
