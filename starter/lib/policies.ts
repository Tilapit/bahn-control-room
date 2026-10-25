// What an agent may do on its own (SPEC 7). Enforced here, in code: the tools and
// the card builder ask this module, never the prompt. Levels can be raised as
// agents earn trust, except contact with a customer, which never becomes automatic.

import { randomUUID } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import type { CaseFile } from "./case"
import { db } from "./db"
import { policies, policyChanges } from "./schema"

export type Level = "auto" | "approval" | "never"

export type PolicyAction = {
  action: string
  level: Level
  /** Plain words for Settings and for the card's "needs your approval" line. */
  label: string
  reason: string
  /** Contact with anyone who pays. Never automatic, whatever the table says. */
  customerContact?: boolean
  /** A card option can carry this action (otherwise it is a tool the agent uses directly). */
  proposable: boolean
}

export const ACTIONS: PolicyAction[] = [
  { action: "read", level: "auto", label: "Read the order, its timeline, search and past decisions", reason: "Reading changes nothing.", proposable: false },
  { action: "ask_driver", level: "auto", label: "Ask the driver a question", reason: "Asking changes nothing.", proposable: false },
  { action: "ask_site", level: "auto", label: "Ask the pickup or delivery site a question", reason: "Asking changes nothing.", proposable: false },
  { action: "look_up", level: "auto", label: "Look up ferries, trains, hotels, repair shops and drivers", reason: "Looking up changes nothing.", proposable: false },
  { action: "reply_driver", level: "auto", label: "Answer a driver's routine question", reason: "Routine answers come from the order's records.", proposable: false },
  { action: "note", level: "auto", label: "Keep the plan and check again later", reason: "Nothing changes.", proposable: true },
  { action: "message_driver", level: "auto", label: "Send the driver a message", reason: "Drivers are not customers; telling them what was decided needs no approval.", proposable: true },
  { action: "book_ferry", level: "approval", label: "Book a ferry crossing", reason: "it is a booking and a cost", proposable: true },
  { action: "change_ferry_booking", level: "approval", label: "Move a booked ferry crossing", reason: "it changes a booking", proposable: true },
  { action: "book_hotel", level: "approval", label: "Book a hotel for the driver", reason: "it is a booking and a cost", proposable: true },
  { action: "book_driver_travel", level: "approval", label: "Book a train or flight for the driver", reason: "it is a booking and a cost", proposable: true },
  { action: "cancel_driver_travel", level: "approval", label: "Cancel the driver's train, flight or hotel", reason: "it changes a booking", proposable: true },
  { action: "switch_driver", level: "approval", label: "Give the gig to another driver", reason: "it changes a booking", proposable: true },
  { action: "republish_offer", level: "approval", label: "Offer the gig to drivers again", reason: "it changes a booking", proposable: true },
  { action: "raise_fee", level: "approval", label: "Raise the driver fee", reason: "it changes a cost", proposable: true },
  { action: "change_pickup_time", level: "approval", label: "Change the pickup time", reason: "it changes a date", proposable: true },
  { action: "change_delivery_time", level: "approval", label: "Change the delivery time", reason: "it changes a date the customer was promised", proposable: true },
  { action: "book_tow", level: "approval", label: "Book a tow or recovery", reason: "it is a booking and a cost", proposable: true },
  { action: "approve_repair_cost", level: "approval", label: "Agree a repair cost", reason: "it is a cost", proposable: true },
  { action: "message_customer", level: "approval", label: "Email the customer", reason: "it contacts a customer", customerContact: true, proposable: true },
  { action: "call_customer", level: "approval", label: "Call the customer", reason: "it contacts a customer", customerContact: true, proposable: true },
  { action: "call_contact", level: "approval", label: "Call a seller or other contact", reason: "it hands the call to a person", proposable: true },
]

const BY_ACTION = new Map(ACTIONS.map((entry) => [entry.action, entry]))
export const PROPOSABLE = ACTIONS.filter((entry) => entry.proposable).map((entry) => entry.action)

/** Insert any policy row that is missing. Existing rows (and their counters) are kept. */
export async function ensurePolicies(): Promise<void> {
  await db.insert(policies)
    .values(ACTIONS.map((entry) => ({ action: entry.action, level: entry.level, note: entry.label })))
    .onConflictDoNothing()
}

export function describe(action: string): PolicyAction | null {
  return BY_ACTION.get(action) ?? null
}

/**
 * The level that applies, given the table's row for the action (or none). Unknown actions are never allowed; customer
 * contact and a promised date are never automatic, whatever the row says. An automatic action with a cost limit needs
 * approval again when it costs more, or when its cost is not known.
 */
export function effectiveLevel(action: string, row: { level: string; autoLimitEur: number | null } | null | undefined, costEur?: number | null): Level {
  const known = BY_ACTION.get(action)
  if (!known) return "never"
  const level = (row?.level ?? known.level) as Level
  if ((known.customerContact || NEVER_AUTO.has(action)) && level === "auto") return "approval"
  if (level === "auto" && row?.autoLimitEur != null && (costEur == null || costEur > row.autoLimitEur)) return "approval"
  return level
}

/** The level that applies now, from the policies table. */
export async function levelFor(action: string, costEur?: number | null): Promise<Level> {
  const [row] = await db.select().from(policies).where(eq(policies.action, action)).limit(1)
  return effectiveLevel(action, row, costEur)
}

/** Never automatic, whatever the table says: contact with a customer, the date a customer was promised, and a call (a person makes it). */
export const NEVER_AUTO = new Set(["message_customer", "call_customer", "change_delivery_time", "call_contact"])

/** Why a person may not set this level, or null when they may. */
export function refusal(action: string, level: Level): string | null {
  const known = BY_ACTION.get(action)
  if (!known) return `Unknown action ${action}`
  if (level === "auto" && (known.customerContact || NEVER_AUTO.has(action))) return `${known.label} always needs a person.`
  return null
}

/** Change what an agent may do on its own. Logged with who and why; customer contact cannot become automatic. */
export async function setPolicy(action: string, level: Level, options: { limitEur?: number | null; actor: string; reason: string; at: Date }): Promise<void> {
  const refused = refusal(action, level)
  if (refused) throw new Error(refused)
  const known = BY_ACTION.get(action)!
  await ensurePolicies()
  const [row] = await db.select().from(policies).where(eq(policies.action, action)).limit(1)
  const limit = level === "auto" ? options.limitEur ?? null : null
  await db.update(policies).set({ level, autoLimitEur: limit }).where(eq(policies.action, action))
  await db.insert(policyChanges).values({
    id: `pol_${randomUUID().slice(0, 12)}`, at: options.at, action, fromLevel: row?.level ?? known.level, toLevel: level, limitEur: limit,
    actor: options.actor, reason: options.reason,
  })
}

/** Actions that offer the gig to another driver. Nobody has said yes when the option is carried out: the offer goes out with it. */
const OFFERS_GIG = new Set(["switch_driver", "republish_offer"])
/** The action that cancels, or with a new booking changes, the travel booked for the driver who holds the gig. */
const DRIVER_TRAVEL = new Set(["cancel_driver_travel"])

/** What `waitsForBackup` needs to know about an order: does a driver still hold the gig, and is an offer to another driver open. */
export type GigState = { driverHoldsGig: boolean; offeredTo: string | null }

export function gigOf(file: CaseFile): GigState {
  const state = file.order.driver?.state
  return { driverHoldsGig: state === "booked" || state === "driving", offeredTo: file.plan.handover?.to ?? null }
}

/**
 * A precondition, whatever the level and whatever a person's rule says: the current driver's travel is cancelled or
 * changed only after a backup driver has accepted the gig. Until then the current driver is the only driver the car
 * has, and cancelling their train in the same click that only offers the gig leaves nobody if the backup says no.
 * Checked when a card is built (lib/agents/propose.ts) and again by the Executor before it writes anything
 * (lib/executor.ts). Returns why the steps may not go ahead, in words a person can read, or null.
 */
export function waitsForBackup(actions: string[], gig: GigState): string | null {
  if (!gig.driverHoldsGig || !actions.some((action) => DRIVER_TRAVEL.has(action))) return null
  if (actions.some((action) => OFFERS_GIG.has(action))) return "the current driver's travel stays booked until a backup driver has accepted the gig, and this option only offers it"
  if (gig.offeredTo) return `the current driver's travel stays booked until ${gig.offeredTo === "drivers" ? "a driver" : gig.offeredTo} accepts the gig, and nobody has yet`
  return null
}

/** The strictest level across several steps of one option. */
export async function levelForAll(actions: string[], costs: (number | null)[] = []): Promise<Level> {
  const levels = await Promise.all(actions.map((action, index) => levelFor(action, costs[index])))
  if (levels.includes("never")) return "never"
  if (levels.includes("approval")) return "approval"
  return "auto"
}

/** Count a decision on a card whose proposal used this action ("approved unchanged 14 of 15 times"). */
export async function countDecision(action: string, approvedUnchanged: boolean): Promise<void> {
  await ensurePolicies()
  await db.update(policies).set({
    decidedCount: sql`${policies.decidedCount} + 1`,
    approvedUnchangedCount: approvedUnchanged ? sql`${policies.approvedUnchangedCount} + 1` : policies.approvedUnchangedCount,
  }).where(eq(policies.action, action))
}
