"use client"

import { REASON_WORDS, REASONS, type Reason } from "@/lib/reasons"

export type ReasonValue = { reason: Reason | null; text: string }

export const EMPTY_REASON: ReasonValue = { reason: null, text: "" }

/**
 * "Why not as proposed?": one reason is required before Reject, another option or a reply to the agent (checked in
 * code by the decision API too). Send `reason` and `reasonText` with the decision.
 */
export function DecisionReason({ value, onChange, disabled = false }: { value: ReasonValue; onChange: (value: ReasonValue) => void; disabled?: boolean }) {
  return <fieldset className="reason" disabled={disabled}>
    <legend>Why not as proposed? <span className="faint">Pick one; the agents learn from it.</span></legend>
    <div className="reason-chips" role="radiogroup" aria-label="Reason">
      {REASONS.map((reason) => <button key={reason} type="button" role="radio" aria-checked={value.reason === reason}
        className="reason-chip" data-on={value.reason === reason}
        onClick={() => onChange({ ...value, reason: value.reason === reason ? null : reason })}>{REASON_WORDS[reason]}</button>)}
    </div>
    {value.reason && <input className="reason-text" value={value.text} maxLength={300} aria-label="More about the reason (optional)"
      placeholder={value.reason === "other" ? "What was wrong? (optional)" : "Anything to add? (optional)"}
      onChange={(event) => onChange({ ...value, text: event.target.value })} />}
  </fieldset>
}
