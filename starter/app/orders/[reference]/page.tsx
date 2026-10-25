import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { connection } from "next/server"
import { type CaseFact, type CaseFile, type CasePlace, getCase, timeline } from "@/lib/case"
import { sweepDecisions } from "@/lib/decisions"
import { cardsForOrder, orderView } from "@/lib/queue"
import { liveSignals } from "@/lib/signals"
import { statusLine } from "@/lib/status"
import { range, zoneShort } from "@/lib/time"
import { urgency } from "@/lib/urgency"
import { Icon } from "../../ui/icons"
import { OrderCard } from "../../ui/order-card"
import { Timeline } from "../../ui/timeline"
import { SourceChip } from "../../ui/when"

type Props = { params: Promise<{ reference: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { reference } = await params
  return { title: reference.toUpperCase() }
}

const placeName = (place: CasePlace | null) => !place ? "Unknown" : place.kind === "private" ? `Private address, ${place.city}` : `${place.name}, ${place.city}`

export default async function OrderPage({ params }: Props) {
  await connection()
  await sweepDecisions()
  const { reference } = await params
  const file = await getCase(reference)
  if (!file) notFound()
  const now = file.asOf
  const at = new Date(now)
  const [entries, items] = await Promise.all([timeline(file.order.id), cardsForOrder(file, at)])
  const { order } = file
  const view = orderView(file)
  const zone = view.zone
  const card = items[0] ?? null
  // With a card, its own deadline (a proposed train that leaves first) is the one the header names.
  const u = card ? card.urgency : urgency(file, at)
  const issue = card ? card.card.headline.replace(`${order.car.label}: `, "") : liveSignals(file)[0] ?? null
  const status = statusLine(file, u, at, issue)
  const href = (entryId: string | null) => entryId ? `#${entryId}` : null

  return <main className="content wide">
    <nav className="crumbs" aria-label="Breadcrumb"><Link href="/orders">Orders</Link><span>/</span><span>{order.reference}</span></nav>
    <header className="case-head">
      <div>
        <h1 className="case-title">{order.car.label}{order.car.year ? ` ${order.car.year}` : ""}<span className="ref">{order.reference}</span></h1>
        <p className="case-status">
          {u.safety && <span className="tag safety" style={{ marginRight: 8 }}>Safety</span>}
          {status}
        </p>
        <div className="case-meta">
          <span><Icon name="route" />{placeName(order.route.from)} → {order.route.via ? `${placeName(order.route.via)} → ` : ""}{placeName(order.route.to)}{order.route.distanceKm ? ` · ${order.route.distanceKm.toLocaleString("en-GB")} km` : ""}{order.route.ferry ? " with ferry" : ""}</span>
          <span><Icon name="driver" />{order.driver ? `${order.driver.name}, ${order.driver.state === "driving" ? "on the gig" : order.driver.state === "finished" ? "finished" : order.driver.state === "cancelled" ? "cancelled the gig" : "driver, booked"}` : "No driver booked"}</span>
          <span><Icon name="building" />{order.customer.name}</span>
          {order.synthetic && <span className="faint">Scale mode: a made-up copy of <Link className="link" href={`/orders/${order.synthetic}`}>{order.synthetic}</Link></span>}
          {(order.car.registration || order.tradeIn) && <span><Icon name="car" />{[order.car.registration, order.tradeIn ? `with trade-in ${order.tradeIn.label}` : null].filter(Boolean).join(" · ")}</span>}
        </div>
      </div>
      {order.car.image && <figure className="case-figure"><img className="case-car" src={order.car.image} alt={`Illustration of a ${order.car.label}`} title="Model illustration, not a photo of this car" /><figcaption>Model illustration</figcaption></figure>}
    </header>

    <div className="case-grid">
      <div>
        {card && <OrderCard item={card} now={now} />}
        {!card && <OpenItems file={file} now={now} zone={zone} />}
        <Timeline entries={entries} now={now} zone={zone} place={(order.pickedUpAt || order.stage.key === "delivered" ? order.route.to?.city : order.route.from?.city) ?? null} zoneName={zone ? zoneShort(now, zone) : null} />
      </div>

      <aside className="case-side">
        <section aria-label="Key times">
          <div className="section-title"><span>Key times</span></div>
          <div className="times">
            {file.keyTimes.map((time) => {
              const risk = (time.key === "ferry_cutoff" || time.key === u.kind) && u.timeRisk
              return <div className="time-row" key={`${time.key}-${time.start}`}>
                <div className="label">{time.label}{time.place ? ` · ${time.place}` : ""}</div>
                {/* A stale estimate is shown, but not as firmly as a promise or a booking. */}
                <div className={`value${risk ? " time" : ""}${time.note?.startsWith("Stale") ? " stale" : ""}`}>{range(time.start, time.end, time.zone)}</div>
                <div className="sub">
                  {time.note && <>{time.note} · </>}
                  {/* The source's time in the same zone as the key time above it, so one event never shows two clocks. */}
                  <SourceChip label={time.source.chip} at={time.source.at} now={now} zone={time.zone ?? zone} href={href(time.source.entryId)} named={!!time.zone && time.zone !== zone} />
                </div>
              </div>
            })}
            {file.keyTimes.length === 0 && <p className="note">No slot, promise or booking times recorded yet.</p>}
          </div>
        </section>

        <Agreed facts={file.facts} now={now} zone={zone} stage={order.stage.key} />

        <section aria-label="Route and travel">
          <div className="section-title"><span>Route and travel</span></div>
          <div className="plan">
            {file.plan.legs.map((leg, index) => <div className="plan-item" key={index}>
              <span>{leg.from} → {leg.to}</span>
              <span className="faint">{leg.mode}{leg.distanceKm ? `, ${leg.distanceKm} km` : ""} · {leg.status}{leg.driver ? ` · ${leg.driver}` : ""}</span>
            </div>)}
            {file.plan.offer && <div className="plan-item"><span className="faint">Gig {file.plan.offer.state}{file.plan.offer.fee ? `, ${file.plan.offer.fee}` : ""}</span></div>}
            {file.plan.bookings.map((booking) => <div className="plan-item" key={booking.id}>
              <span className={`kind ${booking.state === "booked" ? "booked" : "lost"}`}>{booking.state === "booked" ? "Booked" : "Booking lost"}</span>
              <span>{booking.summary.replace(/^(Replacement ferry|Ferry|Train|Flight|Hotel) booked( for the driver)?: /, "$1: ")}</span>
              <SourceChip label={booking.source.chip} at={booking.source.at} now={now} zone={zone} href={href(booking.source.entryId)} />
            </div>)}
            {file.plan.quotes.map((quote) => <div className="plan-item" key={quote.id}>
              <span className={`kind ${quote.state === "sold out" ? "lost" : "quote"}`}>{quote.state === "sold out" ? "Sold out" : "Quote, not booked"}</span>
              <span>{quote.summary.replace(/^(\w+) (quote, not booked|sold out): /, "$1: ")}</span>
              <SourceChip label="Checked" at={quote.checkedAt} now={now} zone={zone} href={href(quote.source.entryId)} />
            </div>)}
            {file.plan.lastPosition && order.stage.key === "moving" && <div className="plan-item">
              <span className="kind">Last position</span>
              <span>{file.plan.lastPosition.kmToGo ?? "?"} km to go, {file.plan.lastPosition.quality} signal from the driver app</span>
              <SourceChip label="GPS" at={file.plan.lastPosition.at} now={now} zone={zone} href={href(file.plan.lastPosition.source.entryId)} />
            </div>}
            {!file.plan.legs.length && <p className="note">No route plan yet.</p>}
          </div>
        </section>
      </aside>
    </div>
  </main>
}

function Agreed({ facts, now, zone, stage }: { facts: CaseFact[]; now: string; zone: string | null; stage: string }) {
  // Slots and promises are already under Key times, with the same source.
  const shown = facts.filter((fact) => !(fact.kind === "agreement" && /^(Pickup slot|Delivery promise)/.test(fact.subject)))
  const current = shown.filter((fact) => !fact.historical)
  const past = shown.filter((fact) => fact.historical)
  const row = (fact: CaseFact) => <div className={`fact${fact.historical ? " historical" : ""}`} key={fact.id}>
    <div className="subject">{fact.subject}</div>
    {/* Statements filed before word-safe cutting stopped at 240 characters mid-word. */}
    <div className="value">{fact.value.length >= 240 && !/[.!?…]$/.test(fact.value) ? `${fact.value.replace(/\s+\S*$/, "")}…` : fact.value}</div>
    <div className="meta">
      <span className={`state ${fact.status}`}>{fact.status === "verified" ? "Confirmed" : "Stated, not confirmed"}</span>
      <SourceChip label={fact.source.chip} at={fact.source.at} now={now} zone={zone} href={fact.source.entryId ? `#${fact.source.entryId}` : null} />
    </div>
  </div>
  const confirmed = current.filter((fact) => fact.status === "verified").length
  return <section aria-label="Agreed and stated">
    <div className="section-title"><span>Agreed and stated</span><span className="count">{confirmed} of {current.length} confirmed</span></div>
    <div className="facts">
      {current.map(row)}
      {current.length === 0 && <p className="note">Nothing agreed or stated for this stage yet.</p>}
      {past.length > 0 && <details>
        <summary className="disclosure">{past.length} earlier {past.length === 1 ? "statement" : "statements"} from before the {stage === "delivered" ? "handovers" : "pickup"}</summary>
        <div className="facts" style={{ marginTop: 10 }}>{past.map(row)}</div>
      </details>}
    </div>
  </section>
}

function OpenItems({ file, now, zone }: { file: CaseFile; now: string; zone: string | null }) {
  const { open } = file
  const items = [
    ...open.alerts.map((alert) => ({ text: `${alert.label}. ${alert.taken ? `Taken by ${alert.owner ?? "a desk"}.` : "Nobody has taken it yet."}`, source: alert.source })),
    ...open.incidents.map((incident) => ({ text: `Incident: ${incident.label}`, source: incident.source })),
    ...open.tasks.map((task) => ({ text: `${task.label} (${task.owner ?? "Ops"}). ${task.nextAction ?? ""}`, source: task.source })),
    ...open.proposals.map((proposal) => ({ text: `Earlier ${proposal.agent.toLowerCase()} proposal, ${proposal.state}: ${proposal.summary}`, source: proposal.source })),
    ...open.conversations.filter((thread) => thread.unanswered && thread.lastInbound).map((thread) => ({ text: `Not answered: ${thread.lastInbound!.author}: “${thread.lastInbound!.text}”`, source: thread.lastInbound!.source })),
    ...open.supportInbox.map((thread) => ({ text: thread.linked ? `Support request open: ${thread.topic.toLowerCase()}${thread.waitingOn ? `, waiting for ${thread.waitingOn}` : ""}.` : `A support message not yet linked to an order may be about this one: ${thread.basis ?? thread.topic}`, source: thread.source })),
    ...open.claims.map((claim) => ({ text: `Unresolved claim: ${claim.text}`, source: claim.source })),
  ]
  if (!items.length) return null
  return <section aria-label="Open on this order" style={{ marginBottom: 28 }}>
    <div className="section-title"><span>Open on this order</span><span className="count">no card for a person</span></div>
    <ul className="open-items">
      {items.map((item, index) => <li className="open-item" key={index}>
        <span>{item.text}</span>
        <SourceChip label={item.source.chip} at={item.source.at} now={now} zone={zone} href={item.source.entryId ? `#${item.source.entryId}` : null} />
      </li>)}
    </ul>
  </section>
}
