// What the Settings pages show: the permission table in plain words with its counters
// and change log, and the eval cases filed from people's corrections.

import { desc, eq } from "drizzle-orm"
import { db } from "./db"
import { ACTIONS, ensurePolicies, NEVER_AUTO } from "./policies"
import { cards, evalCases, orders, policies, policyChanges } from "./schema"

export type PermissionRow = {
  action: string; label: string; level: "auto" | "approval" | "never"; defaultLevel: string; reason: string
  locked: string | null; approvedUnchanged: number; decided: number; limitEur: number | null; costs: boolean
  /** Reading, asking and looking up: always allowed, shown together as one line. */
  always: boolean
}

const COSTS = new Set(["book_ferry", "change_ferry_booking", "book_hotel", "book_driver_travel", "book_tow", "approve_repair_cost", "raise_fee"])

export async function permissions(): Promise<{ rows: PermissionRow[]; changes: (typeof policyChanges.$inferSelect & { label: string })[] }> {
  await ensurePolicies()
  const [rows, changes] = await Promise.all([db.select().from(policies), db.select().from(policyChanges).orderBy(desc(policyChanges.at)).limit(30)])
  const byAction = new Map(rows.map((row) => [row.action, row]))
  return {
    rows: ACTIONS.map((entry) => {
      const row = byAction.get(entry.action)
      return {
        action: entry.action, label: entry.label, level: (row?.level ?? entry.level) as PermissionRow["level"], defaultLevel: entry.level, reason: entry.reason,
        locked: entry.customerContact ? "Always asks: it contacts a customer." : NEVER_AUTO.has(entry.action) ? "Always asks: it changes a date the customer was promised." : !entry.proposable ? entry.reason : null,
        always: !entry.proposable,
        approvedUnchanged: row?.approvedUnchangedCount ?? 0, decided: row?.decidedCount ?? 0, limitEur: row?.autoLimitEur ?? null, costs: COSTS.has(entry.action),
      }
    }),
    changes: changes.map((change) => ({ ...change, label: ACTIONS.find((entry) => entry.action === change.action)?.label ?? change.action })),
  }
}

export async function learningCases() {
  const rows = await db.select({ id: evalCases.id, createdAt: evalCases.createdAt, proposal: evalCases.agentProposal, correction: evalCases.humanCorrection, lastResult: evalCases.lastResult, reference: orders.reference, cardId: evalCases.cardId })
    .from(evalCases).leftJoin(cards, eq(cards.id, evalCases.cardId)).leftJoin(orders, eq(orders.id, cards.orderId)).orderBy(desc(evalCases.createdAt))
  return rows.map((row) => {
    const proposal = (row.proposal ?? {}) as { headline?: string; options?: { label?: string }[] }
    const correction = (row.correction ?? {}) as { choice?: string; reply?: string | null; rejected?: string | null; note?: string | null; expected?: string | null }
    return { id: row.id, createdAt: row.createdAt.toISOString(), reference: row.reference, headline: proposal.headline ?? "", proposed: proposal.options?.[0]?.label ?? null, correction, lastResult: row.lastResult }
  })
}
