// Live timeline entries written by agents, simulated parties and the Executor.
// Every entry points at the row that holds its evidence (an agent step, a demo
// event, a decision), so the source chip on a card always leads somewhere real.

import { randomUUID } from "node:crypto"
import { db } from "../db"
import { demoEvents, timelineEntries } from "../schema"
import type { Evidence } from "../schema"

export type LiveEntry = {
  id?: string
  orderId: string | null
  at: Date
  source: string
  channel?: string | null
  authorType?: string | null
  authorId?: string | null
  authorLabel?: string | null
  kind: string
  summary: string
  body?: string | null
  status?: string | null
  visibility?: "public" | "internal"
  evidence: Evidence
  language?: string | null
}

export async function writeEntry(entry: LiveEntry): Promise<string> {
  const id = entry.id ?? `live:${randomUUID()}`
  await db.insert(timelineEntries).values({
    id, orderId: entry.orderId, occurredAt: entry.at, receivedAt: entry.at, source: entry.source, channel: entry.channel ?? null,
    authorType: entry.authorType ?? null, authorId: entry.authorId ?? null, authorLabel: entry.authorLabel ?? null,
    kind: entry.kind, summary: entry.summary, body: entry.body ?? null, status: entry.status ?? null,
    visibility: entry.visibility ?? "internal", evidence: entry.evidence, language: entry.language ?? null, origin: "live",
  })
  return id
}

/** A demo event row (an injected or simulated message) as the evidence for its timeline entry. */
export async function writeDemoEvent(orderId: string | null, kind: string, payload: Record<string, unknown>, at: Date): Promise<string> {
  const id = `demo_${randomUUID()}`
  await db.insert(demoEvents).values({ id, createdAt: at, orderId, kind, payload })
  return id
}
