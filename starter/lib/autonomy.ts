// Autonomy grows as agents earn trust (brief): when a person has approved the same
// kind of action, exactly as the agent proposed it, N times, For you offers once to
// let the agent do these without asking, up to the highest cost they approved.
// Code decides when to offer; "Yes" changes the policy and logs who and why.

import { and, eq, isNotNull, isNull } from "drizzle-orm"
import { now as clockNow } from "./clock"
import { db } from "./db"
import { rateOf } from "./learning"
import { describe, NEVER_AUTO, PROPOSABLE, setPolicy } from "./policies"
import { cards, decisions, demoSettings, policies } from "./schema"

/** How many unchanged approvals before the suggestion appears. 5 by default; the Demo page can set it. */
export async function autonomyThreshold(): Promise<number> {
  const [row] = await db.select().from(demoSettings).where(eq(demoSettings.key, "autonomy_threshold")).limit(1)
  return typeof row?.value === "number" && row.value >= 1 ? row.value : 5
}

export async function setAutonomyThreshold(n: number): Promise<void> {
  const value = Math.max(1, Math.min(20, Math.round(n)))
  await db.insert(demoSettings).values({ key: "autonomy_threshold", value }).onConflictDoUpdate({ target: demoSettings.key, set: { value } })
}

/** "ferry bookings", for "You approved 5 ferry bookings under €400 unchanged". */
const PLURAL: Record<string, { many: string; verb: string }> = {
  book_ferry: { many: "ferry bookings", verb: "book these ferries" },
  change_ferry_booking: { many: "ferry rebookings", verb: "move these ferry bookings" },
  book_hotel: { many: "hotel bookings for drivers", verb: "book these hotels" },
  book_driver_travel: { many: "train and flight bookings for drivers", verb: "book this driver travel" },
  cancel_driver_travel: { many: "cancellations of driver travel", verb: "cancel driver travel" },
  switch_driver: { many: "driver switches", verb: "offer gigs to backup drivers" },
  republish_offer: { many: "republished gig offers", verb: "republish offers" },
  raise_fee: { many: "driver fee raises", verb: "raise fees" },
  change_pickup_time: { many: "pickup time changes", verb: "change pickup times" },
  book_tow: { many: "tow bookings", verb: "book tows" },
  approve_repair_cost: { many: "repair cost approvals", verb: "agree repair costs" },
  call_contact: { many: "calls to sellers and other contacts", verb: "put these calls on the list" },
}

export type Suggestion = { action: string; count: number; limitEur: number | null; text: string; yesLabel: string }

/** The highest price of this action among the approvals it rests on, rounded up to the next €100. */
async function approvedPriceLimit(action: string): Promise<number | null> {
  const rows = await db.select({ choice: decisions.choice, options: cards.options }).from(decisions).innerJoin(cards, eq(cards.id, decisions.cardId))
    .where(and(isNotNull(decisions.finalizedAt), isNull(decisions.undoneAt)))
  let max = 0
  for (const row of rows) {
    const option = row.options.find((item) => item.id === row.choice)
    if (!option || option.id !== row.options[0]?.id) continue
    for (const step of option.steps ?? []) {
      const cents = (step.params.lookup as { price_cents?: number | null } | undefined)?.price_cents
      if (step.action === action && cents) max = Math.max(max, cents / 100)
      if (step.action === action && step.action === "raise_fee" && typeof step.params.amount_eur === "number") max = Math.max(max, step.params.amount_eur)
    }
  }
  return max ? Math.ceil((max + 1) / 100) * 100 : null
}

/** At most one suggestion: the action with the most unchanged approvals that has reached the threshold. */
export async function autonomySuggestion(): Promise<Suggestion | null> {
  const threshold = await autonomyThreshold()
  const rows = await db.select().from(policies)
  const candidates = rows
    .filter((row) => row.level === "approval" && PROPOSABLE.includes(row.action) && !NEVER_AUTO.has(row.action) && !describe(row.action)?.customerContact && PLURAL[row.action])
    // Trust is earned: enough approvals as proposed, and nearly every decision on it was one.
    .filter((row) => row.approvedUnchangedCount >= threshold && row.approvedUnchangedCount >= row.suggestionDismissedAt + threshold)
    // The acceptance rate Settings → Learning shows (lib/learning.ts): at least 90% approved unchanged.
    .filter((row) => (rateOf(row.approvedUnchangedCount, row.decidedCount) ?? 0) >= 0.9)
    .sort((a, b) => b.approvedUnchangedCount - a.approvedUnchangedCount)
  const row = candidates[0]
  if (!row) return null
  const limitEur = await approvedPriceLimit(row.action)
  const words = PLURAL[row.action]
  return {
    action: row.action, count: row.approvedUnchangedCount, limitEur,
    text: `You approved ${row.approvedUnchangedCount} ${words.many}${limitEur ? ` under €${limitEur}` : ""} unchanged. Let the agent do these without asking?`,
    yesLabel: `Yes: let the agent ${words.verb}${limitEur ? ` under €${limitEur}` : ""}`,
  }
}

export async function answerSuggestion(action: string, answer: "yes" | "not_now", actor = "Ops"): Promise<string> {
  const suggestion = await autonomySuggestion()
  if (!suggestion || suggestion.action !== action) throw new Error("This suggestion is no longer open.")
  if (answer === "not_now") {
    await db.update(policies).set({ suggestionDismissedAt: suggestion.count }).where(eq(policies.action, action))
    return "Not now. The agent keeps asking; the question comes back after more approvals."
  }
  await setPolicy(action, "auto", {
    limitEur: suggestion.limitEur, actor, at: await clockNow(),
    reason: `Accepted the suggestion after ${suggestion.count} approvals unchanged${suggestion.limitEur ? `; only up to €${suggestion.limitEur}` : ""}.`,
  })
  return `From now on the agent does ${PLURAL[action].many}${suggestion.limitEur ? ` under €${suggestion.limitEur}` : ""} without asking, and tells you on the order. Change it in Settings.`
}
