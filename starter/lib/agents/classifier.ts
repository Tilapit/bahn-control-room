// The Classifier (SPEC 7, Haiku): every message passes through it once. It says
// what the message is, whether it changes a fact, and which facts and agreements it
// states. It may only write facts (status "claimed": a message is a claim). Code
// files them and decides what happens next (lib/router.ts).

import { randomUUID } from "node:crypto"
import { and, eq, inArray } from "drizzle-orm"
import { type CaseFile, getCase, type TimelineItem } from "../case"
import { now as clockNow } from "../clock"
import { db } from "../db"
import { ROLE_MODEL } from "../models"
import { facts, timelineEntries } from "../schema"
import { at } from "../time"
import { callJson, prompt } from "./llm"
import { addStep, addUsageToRun, createRun, nextStepIndex, updateRun } from "./runs"

export type Classification = {
  intent: "question" | "update" | "request" | "agreement" | "complaint" | "other"
  urgency: "safety" | "time" | "normal"
  changes_a_fact: boolean
  facts: { subject: string; value: string; kind: "fact" | "agreement" }[]
  needs: "investigator" | "driver_support" | "nothing"
  reason: string
  suggested_order: string | null
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "urgency", "changes_a_fact", "facts", "needs", "reason", "suggested_order"],
  properties: {
    intent: { type: "string", enum: ["question", "update", "request", "agreement", "complaint", "other"] },
    urgency: { type: "string", enum: ["safety", "time", "normal"] },
    changes_a_fact: { type: "boolean" },
    facts: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["subject", "value", "kind"], properties: { subject: { type: "string" }, value: { type: "string" }, kind: { type: "string", enum: ["fact", "agreement"] } } },
    },
    needs: { type: "string", enum: ["investigator", "driver_support", "nothing"] },
    reason: { type: "string" },
    suggested_order: { type: ["string", "null"] },
  },
}

const WHO: Record<string, string> = { driver: "the driver", customer: "the customer", site_contact: "the site", handoff_contact: "the handover contact", operator: "a colleague at Bahn", agent: "a Bahn agent" }

function orderSummary(file: CaseFile): string {
  const { order } = file
  const keyTimes = file.keyTimes.map((time) => `${time.label}${time.place ? ` (${time.place})` : ""}: ${at(time.start, time.zone)}`).join("; ")
  const open = [...file.open.alerts.map((alert) => `alert: ${alert.label}`), ...file.open.tasks.map((task) => `task: ${task.label}`), ...file.open.incidents.map((incident) => `incident: ${incident.label}`)].join("; ")
  return [
    `${order.reference}: ${order.car.label}, ${order.route.from?.city ?? "?"} to ${order.route.to?.city ?? "?"}, ${order.stage.label.toLowerCase()}.`,
    `Customer: ${order.customer.name}. Driver: ${order.driver?.name ?? "none"}.`,
    keyTimes ? `Key times: ${keyTimes}.` : null,
    open ? `Open: ${open}.` : null,
  ].filter(Boolean).join("\n")
}

/**
 * Classify one message entry and file the facts it states. Returns the classification and the classifier run id.
 * A live message gets a run of its own; the backfill passes `runId` so one order's messages share one run.
 */
export async function classifyEntry(entryId: string, options: { trigger?: string; runId?: string } = {}): Promise<{ runId: string; classification: Classification; factIds: string[] } | null> {
  const [row] = await db.select().from(timelineEntries).where(eq(timelineEntries.id, entryId)).limit(1)
  if (!row || row.kind !== "message" || !row.orderId) return null
  const file = await getCase(row.orderId)
  if (!file) return null
  const known = await db.select().from(facts).where(and(eq(facts.orderId, row.orderId), inArray(facts.status, ["claimed", "verified"])))
  const subjects = [...new Set(known.map((fact) => fact.subject))]
  const zone = file.order.route.from?.zone ?? null
  const user = [
    `ORDER\n${orderSummary(file)}`,
    subjects.length ? `SUBJECTS ALREADY RECORDED FOR THIS ORDER\n${subjects.map((subject) => `- ${subject}`).join("\n")}` : null,
    `MESSAGE\nFrom ${row.authorLabel ?? "someone"} (${WHO[row.authorType ?? ""] ?? row.authorType ?? "unknown"}), ${row.channel ?? row.source}${row.visibility === "internal" ? ", internal note" : ""}, ${at(row.occurredAt, zone)}${row.language && row.language !== "en" ? `, written in ${row.language}` : ""}:\n${row.body ?? row.summary}`,
  ].filter(Boolean).join("\n\n")

  const started = await clockNow()
  const runId = options.runId ?? await createRun({ orderId: row.orderId, agent: "Classifier", model: ROLE_MODEL.classifier, trigger: options.trigger ?? `Message from ${row.authorLabel ?? "someone"}`, at: started })
  const result = await callJson<Classification>({ model: ROLE_MODEL.classifier, system: prompt("classifier"), user, schema: SCHEMA, effort: "low" })
  await addUsageToRun(runId, result.model, result.usage)
  const classification = result.value

  // File the facts. A message is a claim; a newer fact on the same subject supersedes the older one.
  const factIds: string[] = []
  for (const fact of classification.facts.slice(0, 2)) {
    const id = `fact_${randomUUID().slice(0, 12)}`
    // Only a newer statement supersedes: backfill and late uploads can arrive out of order.
    const older = known.filter((candidate) => candidate.subject.toLowerCase() === fact.subject.toLowerCase() && candidate.origin !== "dataset" && candidate.statedAt <= row.occurredAt)
    await db.insert(facts).values({
      id, orderId: row.orderId, subject: fact.subject.slice(0, 80), value: fact.value.slice(0, 240), status: "claimed",
      sourceEntryId: row.id, statedByLabel: `${row.authorLabel ?? "Someone"}, ${sourceWord(row)}`, statedAt: row.occurredAt,
      kind: fact.kind, origin: "classifier",
    })
    for (const old of older) await db.update(facts).set({ status: "superseded", supersededBy: id }).where(eq(facts.id, old.id))
    factIds.push(id)
  }
  await addStep(runId, options.runId ? await nextStepIndex(runId) : 0, { at: started, type: "tool_result", tool: "classify", input: { entryId, message: row.body ?? row.summary }, output: { ...classification, factIds }, summary: describe(classification, row as unknown as TimelineItem) })
  if (!options.runId) await updateRun(runId, { status: "done", finishedAt: await clockNow(), outcomeSummary: describe(classification, row as unknown as TimelineItem) })
  return { runId, classification, factIds }
}

function sourceWord(entry: { source: string; channel: string | null }): string {
  if (entry.source === "driver_chat") return "driver chat"
  if (entry.source === "email") return "email"
  if (entry.source === "support") return entry.channel === "site_chat" ? "site chat" : "support chat"
  if (entry.source === "slack") return "internal note"
  if (entry.source === "call") return "phone"
  return "message"
}

function describe(classification: Classification, entry: { authorLabel: string | null }): string {
  const what = { question: "a question", update: "an update", request: "a request", agreement: "an agreement", complaint: "a complaint", other: "a message" }[classification.intent]
  const facts = classification.facts.length ? `; filed ${classification.facts.length} fact${classification.facts.length === 1 ? "" : "s"}` : ""
  const next = classification.needs === "investigator" ? "; worth a look by the Investigator" : classification.needs === "driver_support" ? "; a routine question for Driver support" : ""
  return `Read ${what} from ${entry.authorLabel ?? "someone"}${classification.urgency === "safety" ? " about safety" : ""}${facts}${next}`
}
