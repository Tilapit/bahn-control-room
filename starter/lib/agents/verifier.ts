// The Verifier (SPEC 7, Haiku): checks every claim on a card against the record
// it cites before a person sees it. It annotates; it does not rewrite. Code sends
// its "fix" verdict back to the Investigator once, then stores the notes on the card.

import type { TimelineItem } from "../case"
import { ROLE_MODEL } from "../models"
import type { VerifierNote } from "../schema"
import { at } from "../time"
import { callJson, prompt } from "./llm"

export type CardDraft = {
  headline: string
  whatHappened: string
  findings: { text: string; entry: TimelineItem; also?: TimelineItem | null }[]
  options: { label: string; effect: string; steps: string[] }[]
  rejectLabel: string
  /** Other records on the order that bear on where the car is (recent driver messages, last GPS, terminal estimate), cited or not. */
  context: TimelineItem[]
}

type Verdict = {
  findings: { index: number; ok: boolean; note: string }[]
  card: { ok: boolean; note: string }[]
  sources_conflict: boolean
  conflict: string
  verdict: "pass" | "fix"
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "card", "sources_conflict", "conflict", "verdict"],
  properties: {
    findings: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["index", "ok", "note"], properties: { index: { type: "integer" }, ok: { type: "boolean" }, note: { type: "string" } } },
    },
    card: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["ok", "note"], properties: { ok: { type: "boolean" }, note: { type: "string" } } },
    },
    sources_conflict: { type: "boolean" },
    conflict: { type: "string" },
    verdict: { type: "string", enum: ["pass", "fix"] },
  },
}

function recordKind(entry: TimelineItem): string {
  if (entry.kind === "message") {
    const who = entry.authorType === "driver" ? "the driver" : entry.authorType === "customer" ? "the customer" : entry.authorType === "site_contact" ? "the site" : entry.authorType === "agent" ? "an agent" : "Ops"
    return `message from ${who}${entry.visibility === "internal" ? " (internal note)" : ""}`
  }
  if (entry.source === "gps") return "GPS observation from the driver app: km to go to the delivery address and the app's ETA there, no position"
  if (entry.source === "quote") return entry.status === "quote" ? "quote, not a booking" : "availability check, not a booking"
  if (entry.source === "booking") return entry.status === "booked" ? "booking" : "booking record"
  if (entry.kind === "alert") return "alert (a signal, not a diagnosis)"
  if (entry.source === "agent" && entry.channel === "agent_lookup") return `look-up made by the investigating agent (${entry.authorLabel ?? "agent"})`
  if (entry.source === "agent") return `record of an earlier Bahn agent (${entry.authorLabel ?? "agent"})`
  return `${entry.sourceLabel.toLowerCase()} record`
}

export async function verifyCard(draft: CardDraft, zone: string | null) {
  const user = [
    `CARD\nHeadline: ${draft.headline}\nWhat happened: ${draft.whatHappened}`,
    `OTHER RECORDS ON THE ORDER (for the conflict check; the card may or may not cite them)\n${draft.context.map((entry) => `- ${recordKind(entry)}, ${entry.authorLabel ?? entry.sourceLabel}, ${at(entry.at, zone)}: ${(entry.body ?? entry.summary).replace(/\s+/g, " ")}`).join("\n") || "- none"}`,
    `FINDINGS AND THEIR SOURCES\n${draft.findings.map((finding, index) => [
      `Finding ${index + 1}: ${finding.text}`,
      `  Cited record (${recordKind(finding.entry)}), ${finding.entry.authorLabel ?? finding.entry.sourceLabel}, ${at(finding.entry.at, zone)}:`,
      `  ${(finding.entry.kind === "message" ? finding.entry.body ?? finding.entry.summary : [finding.entry.summary, finding.entry.body].filter(Boolean).join(". ")).replace(/\s+/g, " ")}`,
      ...(finding.also ? [
        `  Second cited record (${recordKind(finding.also)}), ${finding.also.authorLabel ?? finding.also.sourceLabel}, ${at(finding.also.at, zone)}:`,
        `  ${[finding.also.summary, finding.also.kind === "message" ? null : finding.also.body].filter(Boolean).join(". ").replace(/\s+/g, " ")}`,
      ] : []),
    ].join("\n")).join("\n")}`,
    `OPTIONS (the person sees the button and the effect; "does" is what code will carry out, shown to you only to check that it matches)\n${draft.options.map((option, index) => `${index + 1}. Button "${option.label}". Effect: ${option.effect}. Does: ${option.steps.join("; ") || "nothing, it answers the agent"}`).join("\n")}\nReject button: "${draft.rejectLabel}"`,
  ].join("\n\n")
  const result = await callJson<Verdict>({ model: ROLE_MODEL.verifier, system: prompt("verifier"), user, schema: SCHEMA, effort: "high" })
  const notes: VerifierNote[] = [
    // The prompt numbers findings from 1; notes store them from 0, like the card's findings array.
    ...result.value.findings.map((finding) => ({ finding: Math.max(0, finding.index - 1), ok: finding.ok, note: finding.note })),
    ...result.value.card.map((item) => ({ finding: null, ok: item.ok, note: item.note })),
  ]
  return { verdict: result.value.verdict, notes, conflict: result.value.sources_conflict ? result.value.conflict || "Two sources on the card disagree." : null, call: result }
}
