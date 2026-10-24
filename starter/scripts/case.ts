// npm run case CD-420322 [--json]
// Prints the compiled case file the agents and the order screen read.

import "dotenv/config"
import { type CaseFile, getCase } from "@/lib/case"
import { closeDb } from "@/lib/db"
import { at, range } from "@/lib/time"

function print(file: CaseFile) {
  const { order } = file
  const out: string[] = []
  const line = (text = "") => out.push(text)
  const src = (source: { label: string; at: string | null }) => `[${source.label}${source.at ? ` · ${at(source.at, "UTC")}` : ""}]`
  const place = (p: CaseFile["order"]["route"]["from"]) => p ? (p.kind === "private" ? `private address, ${p.city}` : `${p.name}, ${p.city}`) : "?"

  line(`${order.reference} · ${order.car.label}${order.car.year ? ` ${order.car.year}` : ""}${order.car.registration ? ` · ${order.car.registration}` : ""} · ${order.stage.label}`)
  line(`${order.customer.name}${order.customerReference ? ` (${order.customerReference})` : ""} · ${place(order.route.from)} → ${order.route.via ? `${place(order.route.via)} → ` : ""}${place(order.route.to)} · ${order.route.distanceKm ?? "?"} km ${order.route.kind}${order.route.ferry ? ", with ferry" : ""}`)
  line(`Driver: ${order.driver ? `${order.driver.name} (${order.driver.state})${order.driver.home ? `, lives in ${order.driver.home}` : ""}` : "none booked"}${order.otherDrivers.length ? ` · also: ${order.otherDrivers.map((d) => `${d.name} (${d.state})`).join(", ")}` : ""}`)
  if (order.tradeIn) line(`Trade-in: ${order.tradeIn.label}`)
  line(`As of ${at(file.asOf, "UTC")} (simulated clock)`)

  line("\nKEY TIMES")
  for (const time of file.keyTimes) {
    line(`  ${time.label.padEnd(22)} ${range(time.start, time.end, time.zone).padEnd(36)} ${time.note ? `${time.note} ` : ""}${src(time.source)}`)
  }

  line("\nFACTS AND AGREEMENTS")
  if (!file.facts.length) line("  none recorded")
  for (const fact of file.facts) {
    const mark = fact.status === "verified" ? "✓" : "?"
    line(`  ${mark} ${fact.subject}: ${fact.value}${fact.historical ? " (before handover, historical)" : ""} ${src(fact.source)}`)
  }

  line("\nOPEN")
  const { open } = file
  for (const alert of open.alerts) line(`  Alert (${alert.severity}${alert.taken ? `, taken by ${alert.owner}` : ", nobody has taken it"}): ${alert.label}. ${alert.summary} ${src(alert.source)}`)
  for (const incident of open.incidents) line(`  Incident (${incident.status}, ${incident.owner}): ${incident.label}. ${incident.notes ?? ""} ${src(incident.source)}`)
  for (const task of open.tasks) line(`  Task for ${task.owner}${task.dueAt ? `, due ${at(task.dueAt, "UTC")}` : ""}: ${task.label}. Next: ${task.nextAction} ${src(task.source)}`)
  for (const proposal of open.proposals) line(`  Earlier agent proposal (${proposal.state}): ${proposal.summary} ${proposal.detail ? `— ${proposal.detail}` : ""} ${src(proposal.source)}`)
  for (const card of open.cards) line(`  Card for a person (${card.severity}): ${card.headline}`)
  for (const claim of open.claims) line(`  Unresolved claim: ${claim.text} ${src(claim.source)}`)
  for (const thread of open.conversations) line(`  Conversation (${thread.channel}, ${thread.topic})${thread.unanswered ? " UNANSWERED" : ""}${thread.waitingOn ? `, waiting on ${thread.waitingOn}` : ""}${thread.lastInbound ? `: last from ${thread.lastInbound.author}: "${thread.lastInbound.text}" ${src(thread.lastInbound.source)}` : ""}`)
  for (const support of open.supportInbox) line(`  ${support.linked ? "Support inbox thread" : "Unlinked support message may concern this order"} (${support.topic}${support.waitingOn ? `, waiting on ${support.waitingOn}` : ""}): ${support.basis} ${src(support.source)}`)
  for (const doc of open.documents) line(`  Document ${doc.state}: ${doc.label} ${src(doc.source)}`)
  if (!Object.values(open).some((list) => list.length)) line("  nothing open")

  line("\nPLAN")
  line(`  Stops: ${file.plan.stops.map((stop) => `${stop.role} ${place(stop)}`).join(" → ")}`)
  for (const leg of file.plan.legs) line(`  Leg: ${leg.from} → ${leg.to}, ${leg.mode}, ${leg.distanceKm ?? "?"} km, ${leg.status}${leg.driver ? `, ${leg.driver}` : ""}`)
  if (file.plan.offer) line(`  Driver offer: ${file.plan.offer.state}${file.plan.offer.fee ? `, ${file.plan.offer.fee}` : ""}`)
  for (const booking of file.plan.bookings) line(`  BOOKED${booking.state === "lost" ? " (lost)" : ""}: ${booking.summary} ${src(booking.source)}`)
  for (const quote of file.plan.quotes) line(`  QUOTE ONLY${quote.state === "sold out" ? " (sold out)" : ""}: ${quote.summary} ${src(quote.source)}`)
  if (file.plan.lastPosition) line(`  Last position: ${file.plan.lastPosition.kmToGo ?? "?"} km to go, ${file.plan.lastPosition.quality}, observed ${at(file.plan.lastPosition.at, "UTC")}`)

  line(`\nTIMELINE (latest ${Math.min(15, file.timeline.length)} of the last ${file.timeline.length})`)
  for (const item of file.timeline.slice(0, 15)) {
    line(`  ${at(item.at, "UTC")}  ${`${item.chip}`.padEnd(18)} ${item.summary}`)
  }
  console.log(out.join("\n"))
}

async function main() {
  const args = process.argv.slice(2)
  const reference = args.find((arg) => !arg.startsWith("--"))
  if (!reference) throw new Error("Usage: npm run case CD-420322 [--json]")
  const file = await getCase(reference)
  if (!file) throw new Error(`No order ${reference}`)
  if (args.includes("--json")) console.log(JSON.stringify(file, null, 2))
  else print(file)
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }).finally(closeDb)
