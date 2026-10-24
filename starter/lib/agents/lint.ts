// Checks on a proposed card that code can make without a model: every finding
// cites an entry the agent was shown, no internal words or ids, a quote is not
// called booked, a driver's message is not stated as a position. Failures go
// back to the agent as a tool error so it rewrites the card itself.

import type { TimelineItem } from "../case"

const INTERNAL_WORDS = /\b(assignments?|segments?|endpoints?|payloads?|enums?|json|null|undefined|record ids?|entry ids?|work items?|status codes?)\b/i
const RECORD_ID = /\b(?:ord|msg|asg|seg|res|travel|alert|evt|win|track|point|plan|agent|incident|work|doc|ep|proof|expense|visit|drv|cus|site|addr|offer|step|card|run|demo|live)[-_:]x?[0-9a-z]{4,}/i
const HANDLE = /\[?\bE\d{1,3}\b\]?/
const CODE = /\b[A-Z]{2,}_[A-Z_]{2,}\b/
const OPTION_ID = /\b(?:ferry|hotel|travel|shop):[a-z0-9-]+/i
const BOOKED_CLAIM = /\b(is|was|are|were|has been|have been|now|already|got) booked\b/i
const BOOKED_DENIAL = /\bnot booked\b|\bno .{0,30}booked\b|\bnothing .{0,20}booked\b|\bisn't booked\b|\bunbooked\b/i
const LOCATION_FACT = /\b(?:driver|they|she|he|car)\s+(?:is|are)\s+(?:now\s+)?(?:at|in|near|on|by)\b/i
/** A pronoun guessed from a name misgenders a real person. "they" is always right. */
const GUESSED_PRONOUN = /\b(he|she|him|her|his|hers|himself|herself)\b/i
const HEDGE = /\b(says?|said|writes?|wrote|reports?|reported|claims?|claimed|according to|told|states?|stated|messaged)\b/i

export function textProblems(label: string, text: string): string[] {
  const problems: string[] = []
  const word = text.match(INTERNAL_WORDS)?.[0]
  if (word) problems.push(`${label} uses the internal word "${word}"; say it in ops words`)
  const id = text.match(RECORD_ID)?.[0] ?? text.match(OPTION_ID)?.[0]
  if (id) problems.push(`${label} shows an id ("${id}"); people never see ids`)
  if (HANDLE.test(text)) problems.push(`${label} contains a source handle like E12 in its text; put handles only in "source"`)
  const code = text.match(CODE)?.[0]
  if (code) problems.push(`${label} shows a code ("${code}"); say it in words`)
  // A quote of what someone wrote keeps their words; only the agent's own words are checked.
  const pronoun = text.replace(/[“"‘][^”"’]*[”"’]/g, "").match(GUESSED_PRONOUN)?.[0]
  if (pronoun) problems.push(`${label} uses "${pronoun}"; never guess a pronoun from a name: use the name, the role, or they/them`)
  return problems
}

export type DraftFinding = { text: string; source: string }

/** Problems with one finding against the entry it cites. */
export function findingProblems(index: number, finding: DraftFinding, entry: TimelineItem | null): string[] {
  const label = `Finding ${index + 1}`
  if (!entry) return [`${label} cites "${finding.source}", which is not an entry you were shown; cite a handle from a tool result`]
  const problems = textProblems(label, finding.text)
  const isQuote = entry.source === "quote" || entry.status === "quote"
  if (isQuote && BOOKED_CLAIM.test(finding.text) && !BOOKED_DENIAL.test(finding.text)) {
    problems.push(`${label} says something is booked, but it cites a quote or availability check; a quote is not a booking`)
  }
  const fromDriver = entry.kind === "message" && entry.authorType === "driver"
  if (fromDriver && LOCATION_FACT.test(finding.text) && !HEDGE.test(finding.text)) {
    problems.push(`${label} states where the driver is as a fact, but it cites the driver's own message; write it as what the driver says`)
  }
  return problems
}
