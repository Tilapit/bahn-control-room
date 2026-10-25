// The five reasons a person gives when rejecting or changing a proposal, and the outcome words. No database here:
// the card's reason chips (a client component) import this module.

export const REASONS = ["too_expensive", "wrong_facts", "customer_must_decide", "too_early", "other"] as const
export type Reason = typeof REASONS[number]

/** The chip words, the same on the card and on Settings → Learning. */
export const REASON_WORDS: Record<Reason, string> = {
  too_expensive: "Too expensive", wrong_facts: "Wrong facts", customer_must_decide: "Customer must decide", too_early: "Too early", other: "Other",
}

export const OUTCOME_WORDS: Record<string, string> = { worked: "Worked", partly: "Partly", didnt_work: "Didn't work" }

export const isReason = (value: unknown): value is Reason => typeof value === "string" && (REASONS as readonly string[]).includes(value)

export type Feedback = { reason?: string | null; reasonText?: string | null }

/**
 * What a decision teaches. Approving the agent's own first option is positive and needs no reason. Rejecting it,
 * replying with something else, or choosing another option changes the proposal: negative, and it needs exactly one
 * reason. An answer to the agent's question, or marking an alert handled, is neither.
 */
export function feedbackRule(kind: "approve" | "reject" | "reply" | "answer" | "handled", primary: boolean): { label: "positive" | "negative" | null; needsReason: boolean } {
  if (kind === "answer" || kind === "handled") return { label: null, needsReason: false }
  if (kind === "approve" && primary) return { label: "positive", needsReason: false }
  return { label: "negative", needsReason: true }
}

/** The refusal when a reason is missing or unknown, or null when the feedback is fine. */
export function feedbackError(rule: { needsReason: boolean }, feedback: Feedback): string | null {
  if (!rule.needsReason) return null
  if (!feedback.reason) return "Pick one reason first: Too expensive, Wrong facts, Customer must decide, Too early or Other."
  if (!isReason(feedback.reason)) return "That reason is not one of the five."
  return null
}

/** "approved unchanged", "changed: too early", for a past case in one line. */
export function verdictWords(row: { decision: string; reason: string | null }): string {
  if (row.decision === "approved") return "approved unchanged"
  const reason = isReason(row.reason) ? REASON_WORDS[row.reason].toLowerCase() : null
  return `${row.decision === "changed" ? "changed" : "rejected"}${reason ? `: ${reason}` : ""}`
}
