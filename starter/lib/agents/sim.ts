// Demo only: the simulated driver and site (SPEC 7). Haiku plays the person the
// agent asked, from the order's scenario note and the conversation so far. Each
// reply lands on the timeline like a real message, marked as simulated in the
// evidence row, and the simulated clock moves forward by the time it took.

import { and, asc, eq, inArray } from "drizzle-orm"
import type { CaseFile } from "../case"
import { advance } from "../clock"
import { db } from "../db"
import { ROLE_MODEL } from "../models"
import { timelineEntries } from "../schema"
import { writeDemoEvent, writeEntry } from "./entries"
import { callText, prompt } from "./llm"
import { type Party, scenarioNote } from "./scenarios"

/** How long a simulated person takes to answer, in simulated minutes. */
export const REPLY_MINUTES = 2

export type SimulatedReply = { entryId: string; text: string; at: Date; author: string; usage: Awaited<ReturnType<typeof callText>> }

const LANGUAGE: Record<string, string> = { en: "English", fi: "Finnish", de: "German", fr: "French" }

export function partyName(file: CaseFile, party: Party, side: "pickup" | "delivery" = "pickup"): string {
  if (party === "driver") return file.order.driver?.name ?? "The driver"
  const place = side === "pickup" ? file.order.route.from : file.order.route.to
  const contact = file.facts.find((fact) => fact.subject === (side === "pickup" ? "Pickup contact" : "Delivery contact"))
  return contact ? `${contact.value.split(",")[0]}, ${place?.name ?? "site desk"}` : `${place?.name ?? "Site"} desk`
}

/** The simulated party's answer to one question, written to the timeline. */
export async function simulateReply(file: CaseFile, party: Party, question: string, options: { side?: "pickup" | "delivery"; questionEntryId: string }): Promise<SimulatedReply> {
  const author = partyName(file, party, options.side)
  const note = scenarioNote(file.order.reference, party)
  // The conversation with this party so far, so the simulated person stays consistent.
  const sources = party === "driver" ? ["driver_chat", "support"] : ["call", "support"]
  // site_chat and site_call are the site's channels; the driver's are driver chat and support chat.
  const history = await db.select().from(timelineEntries)
    .where(and(eq(timelineEntries.orderId, file.order.id), eq(timelineEntries.kind, "message"), inArray(timelineEntries.source, sources)))
    .orderBy(asc(timelineEntries.occurredAt))
  const relevant = history.filter((entry) => party === "driver" ? entry.authorType === "driver" || entry.channel === "driver_chat" || entry.authorType === "agent" : entry.authorType === "site_contact" || entry.channel === "site_chat" || entry.channel === "site_call")
  const language = history.filter((entry) => entry.authorType === (party === "driver" ? "driver" : "site_contact")).pop()?.language ?? "en"
  const user = [
    `You are: ${author} (${party === "driver" ? "the driver" : "the site desk"}) on order ${file.order.reference}, a ${file.order.car.label}, ${file.order.route.from?.city ?? "?"} to ${file.order.route.to?.city ?? "?"}.`,
    `Language: ${LANGUAGE[language] ?? "English"}`,
    `What you know:\n${note ?? "Only what the conversation below shows. Anything else, you do not know."}`,
    `Conversation so far (oldest first):\n${relevant.slice(-8).map((entry) => `- ${entry.authorLabel ?? "Someone"}: ${entry.body ?? entry.summary}`).join("\n") || "- (none)"}`,
    `The message you are answering now:\n${question}`,
  ].join("\n\n")
  const result = await callText({ model: ROLE_MODEL.simulatedParty, system: prompt("simulated-party"), user, maxTokens: 600 })
  const at = await advance(REPLY_MINUTES)
  const eventId = await writeDemoEvent(file.order.id, "simulated_reply", { party, author, question, reply: result.value, question_entry_id: options.questionEntryId, model: result.model }, at)
  const entryId = await writeEntry({
    orderId: file.order.id, at, source: party === "driver" ? "driver_chat" : "support", channel: party === "driver" ? "driver_chat" : "site_chat",
    authorType: party === "driver" ? "driver" : "site_contact", authorLabel: author, kind: "message",
    summary: result.value, body: result.value, status: "claimed", visibility: "public", language,
    evidence: { table: "demo_events", id: eventId },
  })
  return { entryId, text: result.value, at, author, usage: result }
}
