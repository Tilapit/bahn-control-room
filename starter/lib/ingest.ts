// Ingest (SPEC 5.4): a new entry for an order's timeline from the demo page or a
// script. It is stored with a demo_events row as its evidence, then a message goes
// through the Classifier once and the Router decides what happens next.

import { getCase } from "./case"
import { now as clockNow } from "./clock"
import { classifyEntry } from "./agents/classifier"
import { writeDemoEvent, writeEntry } from "./agents/entries"
import { hasApiKey } from "./agents/llm"
import { route, type RouteDecision } from "./router"

export type IngestInput = {
  order: string
  source: string
  channel?: string | null
  authorType: string
  authorLabel: string
  kind?: string
  summary?: string | null
  body?: string | null
  visibility?: "public" | "internal"
  language?: string | null
  status?: string | null
  /** What the demo page called it ("red warning light"), kept on the demo event. */
  demoKind?: string
}

export async function ingest(input: IngestInput): Promise<{ entryId: string; eventId: string; orderId: string }> {
  const file = await getCase(input.order)
  if (!file) throw new Error(`No order ${input.order}`)
  const at = await clockNow()
  const kind = input.kind ?? "message"
  const eventId = await writeDemoEvent(file.order.id, input.demoKind ?? kind, { ...input }, at)
  const entryId = await writeEntry({
    orderId: file.order.id, at, source: input.source, channel: input.channel ?? null, authorType: input.authorType, authorLabel: input.authorLabel,
    kind, summary: input.summary ?? input.body ?? "", body: input.body ?? null, visibility: input.visibility ?? "public",
    status: input.status ?? (["driver", "customer", "site_contact", "handoff_contact"].includes(input.authorType) ? "claimed" : null),
    language: input.language ?? "en", evidence: { table: "demo_events", id: eventId },
  })
  return { entryId, eventId, orderId: file.order.id }
}

/** Classify a message and route it. Runs in the background after ingest; agents can take a minute. */
export async function processEntry(entryId: string): Promise<{ classified: boolean; route: RouteDecision | null }> {
  if (!hasApiKey()) return { classified: false, route: null }
  const result = await classifyEntry(entryId)
  const decision = await route(entryId, result?.classification ?? null)
  return { classified: !!result, route: decision }
}
