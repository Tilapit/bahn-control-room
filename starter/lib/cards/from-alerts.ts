// Temporary cards (SPEC phase 2): one per order with an open or taken alert,
// written by code from the case file. Agent runs replace them in phase 4. They
// propose nothing new; the next step shown is the one people or earlier agents
// already recorded, with its source.

import type { CaseFile, SourceRef } from "../case"
import type { CardFinding, CardOption, CardProposal } from "../schema"
import { at as formatAt } from "../time"
import type { Urgency } from "../urgency"

const HEADLINES: Record<string, string> = {
  SAFETY_STOP: "driver stopped with a red warning light",
  TRACKING_GAP: "no position from the driver app",
  FERRY_SOLD_OUT: "ferry sold out, no crossing booked",
  FERRY_CONNECTION_RISK: "driver may miss ferry check-in",
  EMPTY_PICKUP: "driver at the pickup, car not there",
  DRIVER_AVAILABILITY_RISK: "booked driver may be ill",
  RELEASE_DOCUMENT_UNCLEAR: "seller is holding the car back",
  SITE_ACCESS_UNCONFIRMED: "site can't say who has the keys",
  SITE_ACCESS_CONFLICT: "branch and yard disagree where the car is",
  DELIVERY_ACCESS_RISK: "no one confirmed to receive the car",
  PROOF_REVIEW: "signed handover still missing",
  CONDITION_CLAIM_REVIEW: "customer reports a mark after delivery",
  CONDITION_CLAIM: "customer reports a mark after delivery",
  INVOICE_REFERENCE_QUERY: "customer asks about the invoice",
  FR_IMPORT_TRAVEL_DECISION: "ferry sold out, travel plan not booked",
  POSITIONING_AT_RISK: "driver can't reach the pickup in time",
  PICKUP_PROOF_REJECTED: "pickup photos rejected",
  DELIVERY_PROMISE_UNACHIEVABLE: "car waits at the yard, today's delivery can't happen",
}

export type AlertCard = {
  id: string
  orderId: string
  kind: "question"
  status: "open"
  headline: string
  whatHappened: string
  findings: CardFinding[]
  proposal: CardProposal | null
  options: CardOption[]
  consequenceAt: Date | null
  consequenceText: string
  severity: "safety" | "high" | "normal"
  origin: "alert"
}

function finding(text: string, source: SourceRef): CardFinding | null {
  if (!source.entryId || !source.at) return null
  return { text, source_entry_id: source.entryId, source_label: source.chip, at: source.at }
}

/** Some dataset alerts only say "Review … for CD-…; source is a conversation". Then the message that raised it says more. */
function whatHappened(file: CaseFile, alert: CaseFile["open"]["alerts"][number]): string {
  if (!/source is a conversation/i.test(alert.summary)) return alert.summary
  const thread = file.open.conversations.find((candidate) => candidate.id === alert.conversationId)
  const first = thread?.firstInbound
  if (!first) return `${alert.label}. The alert was raised from a conversation; it is a signal, not a verified outcome.`
  const chip = first.source.chip
  const role = chip.startsWith("Driver") ? "the driver, " : chip.startsWith("Customer") ? "the customer, " : chip.startsWith("Site") ? "the site, " : chip.startsWith("Handover") ? "the handover contact, " : ""
  return `${alert.label}, raised from a message by ${role}${first.author}: “${first.text}” The alert is a signal, not a verified outcome.`
}

export function cardFromAlerts(file: CaseFile, urgency: Urgency): AlertCard | null {
  const alerts = file.open.alerts
  if (!alerts.length) return null
  const top = alerts[0]
  const { order, open, plan } = file
  const severity = urgency.safety ? "safety" : alerts.some((alert) => alert.severity === "high" || alert.severity === "critical") ? "high" : "normal"

  const findings: (CardFinding | null)[] = []
  // The top alert's text is already "what happened"; its finding says only who has it.
  alerts.forEach((alert, index) => findings.push(finding(
    `${alert.label}.${index > 0 ? ` ${alert.summary}` : ""}${alert.taken ? ` Taken by ${alert.owner ?? "a desk"}; not resolved.` : " Nobody has taken it yet."}`,
    alert.source,
  )))
  for (const thread of open.conversations) if (thread.lastInbound) findings.push(finding(`${thread.lastInbound.author}: “${thread.lastInbound.text}”${thread.unanswered ? " Not answered yet." : ""}`, thread.lastInbound.source))
  for (const incident of open.incidents) if (incident.notes) findings.push(finding(incident.notes, incident.source))
  if (top.signal.startsWith("FERRY") || top.signal === "FR_IMPORT_TRAVEL_DECISION") {
    for (const booking of plan.bookings.filter((b) => b.kind === "Ferry")) findings.push(finding(booking.summary, booking.source))
    for (const quote of plan.quotes.filter((q) => q.kind === "Ferry")) findings.push(finding(quote.summary, quote.source))
    if (!plan.bookings.some((b) => b.kind === "Ferry" && b.state === "booked")) {
      const anyQuote = plan.quotes.find((q) => q.kind === "Ferry")
      if (anyQuote) findings.push(finding("No ferry is booked for this car. Every crossing listed is a quote or sold out.", anyQuote.source))
    }
  }
  for (const proposal of open.proposals) findings.push(finding(`Earlier ${proposal.agent.toLowerCase()} proposal, ${proposal.state}: ${proposal.summary}${proposal.state === "failed" && proposal.detail ? ` ${proposal.detail}` : ""}`, proposal.source))
  if (order.stage.key === "moving" && plan.lastPosition) {
    const p = plan.lastPosition
    findings.push(finding(`Last driver-app position: ${p.kmToGo ?? "?"} km to go, ${p.quality}, observed ${formatAt(p.at, order.route.to?.zone)}.`, p.source))
  }

  // The next step someone already recorded, with its source. Nothing new is proposed here.
  const task = open.tasks[0]
  const waiting = open.proposals.find((proposal) => proposal.state === "waiting for review")
  const proposal: CardProposal | null = task?.nextAction
    ? { action: "none", params: { source_entry_id: task.source.entryId, source_label: `Task for ${task.owner ?? "Ops"}`, source_at: task.source.at }, effect_text: task.nextAction, requires_approval_reason: null }
    : waiting
      ? { action: "none", params: { source_entry_id: waiting.source.entryId, source_label: `Earlier proposal by the ${waiting.agent.toLowerCase()}, waiting for review`, source_at: waiting.source.at }, effect_text: waiting.summary, requires_approval_reason: null }
      : null

  const options: CardOption[] = [
    { id: "handled", label: "Mark as handled", action: "mark_handled", params: {} },
  ]

  const unique: CardFinding[] = []
  for (const item of findings) {
    if (item && !unique.some((known) => known.source_entry_id === item.source_entry_id && known.text === item.text)) unique.push(item)
  }
  return {
    id: `card-alerts-${order.id}`,
    orderId: order.id,
    kind: "question",
    status: "open",
    headline: `${order.car.label}: ${HEADLINES[top.signal] ?? top.label.toLowerCase()}`,
    whatHappened: whatHappened(file, top),
    findings: unique.slice(0, 7),
    proposal,
    options,
    consequenceAt: urgency.at ? new Date(urgency.at) : null,
    consequenceText: urgency.sentence,
    severity,
    origin: "alert",
  }
}
