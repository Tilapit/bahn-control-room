// Demo only: the backup driver says yes to the gig an approved card offered them (scenario 4, CD-420449). Fictional.
// The yes is recorded like any driver-app event: a demo_events row as its evidence and a timeline entry. From then on
// the backup holds the gig (lib/case.ts), so the precondition in lib/policies.ts lets the replaced driver's travel be
// cancelled. Cancelling a booking needs a person (policies table): code puts a card in For you, and the Executor
// cancels after the undo window. The card asks even under a person's automatic rule: the Executor runs only from a
// person's decision or an agent's rule (tests/policies.test.ts), and asking is the safe side.

import { randomUUID } from "node:crypto"
import { and, eq, ne } from "drizzle-orm"
import { getCase, type CaseFile } from "./case"
import { now as clockNow } from "./clock"
import { db } from "./db"
import { writeDemoEvent, writeEntry } from "./agents/entries"
import { cards, type CardFinding, type CardOption } from "./schema"
import { urgency } from "./urgency"

/** The demo's backup-driver order. */
export const BACKUP_ORDER = "CD-420449"

export type BackupState = {
  reference: string
  /** The open offer: who it went to, while the driver it replaces still holds the gig. */
  offeredTo: string | null
  /** Who said yes, once someone has. */
  acceptedBy: string | null
  /** The replaced driver's travel that is still booked and has not left yet. */
  travel: string[]
}

/** "Carl Birkelane's train, Aalborg to Copenhagen, departs Wed 21 Oct 12:25 CEST": a booking in the words of the card. */
function travelWords(owner: string, summary: string): string {
  return `${owner}'s ${summary.replace(/ booked for the driver/, "").replace(/^(\w+)( in [^:]+)?:\s*/, (_match, kind: string, place?: string) => `${kind.toLowerCase()}${place ?? ""}, `)}`
}

/** Travel the replaced driver still holds: booked, not yet departed (a hotel's time is its check-in). */
function heldTravel(file: CaseFile, now: Date) {
  return file.plan.bookings.filter((booking) => booking.state === "booked" && booking.source.entryId?.startsWith("travel_reservations:")
    && ["Train", "Flight", "Bus", "Hotel"].includes(booking.kind) && (!booking.departureAt || new Date(booking.departureAt).getTime() > now.getTime()))
}

export async function backupState(reference = BACKUP_ORDER): Promise<BackupState | null> {
  const file = await getCase(reference)
  if (!file) return null
  const now = await clockNow()
  const replaced = file.order.otherDrivers.find((driver) => driver.state.startsWith("handed the gig to"))
  const acceptedBy = replaced ? replaced.state.replace(/^handed the gig to /, "") : null
  return { reference, offeredTo: file.plan.handover?.to ?? null, acceptedBy, travel: heldTravel(file, now).map((booking) => booking.summary) }
}

/**
 * The backup accepts. Refused, with what to do first, when no approved card has offered the gig to a named driver.
 * Then code proposes, on a card, cancelling the replaced driver's travel that has not left yet. Nothing is cancelled
 * before the yes is on the timeline, and nothing without a person's approval.
 */
export async function backupAccepts(reference = BACKUP_ORDER): Promise<{ ok: boolean; message: string; cardId?: string }> {
  const file = await getCase(reference)
  if (!file) return { ok: false, message: `No order ${reference}.` }
  const offer = file.plan.handover
  if (!offer) return { ok: false, message: "Approve the offer on For you first: nobody has been offered this gig yet." }
  if (offer.to === "drivers") return { ok: false, message: "This gig went out to all drivers; the demo plays a named backup accepting, not the market." }
  const old = file.order.driver?.name ?? "The driver"
  const now = await clockNow()
  const eventId = await writeDemoEvent(file.order.id, "backup accepted", { driver: offer.to, replacing: old, offeredAt: offer.at }, now)
  const acceptedEntry = await writeEntry({
    orderId: file.order.id, at: now, source: "system", channel: "gig_accepted", authorType: "driver", authorLabel: offer.to, kind: "event", status: "done",
    summary: `${offer.to} accepted the gig in the driver app; ${old} no longer holds it.`, visibility: "internal", evidence: { table: "demo_events", id: eventId },
  })

  const after = await getCase(reference)
  if (!after) return { ok: false, message: `No order ${reference}.` }
  const travel = heldTravel(after, now)
  if (!travel.length) return { ok: true, message: `${offer.to} accepted. ${old} has no booked travel left to cancel.` }

  const steps = travel.map((booking) => ({ action: "cancel_driver_travel", params: { reservation_id: booking.id, text: travelWords(old, booking.summary) } }))
  const first = old.split(" ")[0]
  const option: CardOption = {
    id: "opt-1", label: `Approve: cancel ${first}'s ${list(travel.map((booking) => booking.kind.toLowerCase()))}`, action: "cancel_driver_travel", params: {}, steps,
    effect_text: `Cancels ${old}'s ${list(travel.map((booking) => booking.kind.toLowerCase()))} (simulated); ${offer.to} keeps the gig.`, kind: "approve",
  }
  const findings: CardFinding[] = [
    { text: `${offer.to} accepted the gig in the driver app; ${old} no longer holds it.`, source_entry_id: acceptedEntry, source_label: "Driver app", at: now.toISOString() },
    ...travel.map((booking) => ({ text: `${booking.summary}. Still booked for ${old}.`, source_entry_id: booking.source.entryId ?? acceptedEntry, source_label: booking.source.label, at: booking.source.at ?? now.toISOString() })),
  ]
  const cardId = `card_${randomUUID().slice(0, 12)}`
  const u = urgency(after, now)
  await db.update(cards).set({ status: "expired" }).where(and(eq(cards.orderId, after.order.id), eq(cards.status, "open"), ne(cards.id, cardId)))
  await db.insert(cards).values({
    id: cardId, orderId: after.order.id, runId: null, createdAt: now, kind: "decision", status: "open",
    headline: `${after.order.car.label}: ${offer.to} took the gig; cancel ${first}'s travel`,
    whatHappened: `${offer.to} accepted the gig, so ${old}'s ${list(travel.map((booking) => booking.kind.toLowerCase()))} can be cancelled now. Until the yes, it stayed booked on purpose.`,
    findings, proposal: { action: "cancel_driver_travel", params: {}, effect_text: option.effect_text ?? "", requires_approval_reason: "it changes a booking", cost_eur: null },
    options: [option, { id: "reject", label: "Reject: keep the travel booked", action: "reject", params: {}, kind: "reject" }],
    consequenceAt: u.at ? new Date(u.at) : null, consequenceText: u.sentence, severity: u.timeRisk ? "high" : "normal", verifierNotes: null, origin: "monitor", group: null,
  })
  return { ok: true, message: `${offer.to} accepted. A card on For you asks you to approve cancelling ${first}'s travel.`, cardId }
}

const list = (parts: string[]) => parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
