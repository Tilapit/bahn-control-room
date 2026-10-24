import { sql } from "drizzle-orm"
import { boolean, customType, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

export const datasetMetadata = pgTable("dataset_metadata", {
  id: text("id").primaryKey(),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
  releaseStatus: text("release_status").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
})

export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  country: text("country").notNull(),
  accountTier: text("account_tier").notNull(),
  importBuyer: boolean("import_buyer").notNull(),
})

export const sites = pgTable("sites", {
  id: text("id").primaryKey(),
  customerId: text("customer_id").references(() => customers.id),
  name: text("name").notNull(),
  city: text("city").notNull(),
  country: text("country").notNull(),
  kind: text("kind").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
})

export const addresses = pgTable("addresses", {
  id: text("id").primaryKey(),
  managedSiteId: text("managed_site_id").references(() => sites.id),
  orderId: text("order_id"),
  name: text("name").notNull(),
  city: text("city").notNull(),
  country: text("country").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
})

export const vehicles = pgTable("vehicles", {
  id: text("id").primaryKey(),
  make: text("make").notNull(),
  model: text("model").notNull(),
  modelYear: integer("model_year").notNull(),
  fuel: text("fuel").notNull(),
  registration: text("registration"),
  syntheticVin: text("synthetic_vin"),
})

export const drivers = pgTable("drivers", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  homeCity: text("home_city").notNull(),
  homeCountry: text("home_country").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
})

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  reference: text("reference").notNull().unique(),
  customerId: text("customer_id").notNull().references(() => customers.id),
  pickupSiteId: text("pickup_site_id").references(() => sites.id),
  deliverySiteId: text("delivery_site_id").references(() => sites.id),
  pickupAddressId: text("pickup_address_id").notNull().references(() => addresses.id),
  deliveryAddressId: text("delivery_address_id").notNull().references(() => addresses.id),
  displayLane: text("display_lane").notNull(),
  status: text("status").notNull(),
  routeKind: text("route_kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("orders_lane_updated_idx").on(table.displayLane, table.updatedAt)])

export const orderItems = pgTable("order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  vehicleId: text("vehicle_id").notNull().references(() => vehicles.id),
  role: text("role").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("order_items_order_idx").on(table.orderId)])

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  category: text("category").notNull(),
  channel: text("channel").notNull(),
  status: text("status").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("conversations_order_idx").on(table.orderId)])

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  authorType: text("author_type").notNull(),
  body: text("body").notNull(),
  authoredAt: timestamp("authored_at", { withTimezone: true }).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("messages_conversation_idx").on(table.conversationId, table.authoredAt)])

export const alerts = pgTable("alerts", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  severity: text("severity").notNull(),
  signal: text("signal").notNull(),
  status: text("status").notNull(),
  summary: text("summary").notNull(),
  triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("alerts_order_idx").on(table.orderId)])

export const operationalEvents = pgTable("operational_events", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  command: text("command").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [index("events_order_time_idx").on(table.orderId, table.recordedAt)])

// Less frequently queried types remain accessible without flattening away their source fields.
export const relatedRecords = pgTable("related_records", {
  collection: text("collection").notNull(),
  id: text("id").notNull(),
  orderId: text("order_id").references(() => orders.id),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
}, (table) => [
  primaryKey({ columns: [table.collection, table.id] }),
  index("related_records_order_idx").on(table.orderId, table.collection),
])

// ---------------------------------------------------------------------------
// Control Room V3 tables. None of them has a foreign key to the starter tables,
// so `npm run db:seed` can still replace the snapshot in one transaction.
// ---------------------------------------------------------------------------

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" })

export type Evidence = { table: string; id: string }

/** One row per meaningful record, in one shape, so every channel lands on one timeline per order. */
export const timelineEntries = pgTable("timeline_entries", {
  id: text("id").primaryKey(),
  orderId: text("order_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  // order | gps | driver_chat | support | slack | email | call | booking | quote | alert | agent | person | system
  source: text("source").notNull(),
  channel: text("channel"),
  authorType: text("author_type"),
  authorId: text("author_id"),
  authorLabel: text("author_label"),
  // message | position | booking | quote | alert | event | proposal | decision | fact
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  body: text("body"),
  // claimed | verified | quote | booked | superseded | signal | done
  status: text("status"),
  visibility: text("visibility").notNull().default("internal"),
  evidence: jsonb("evidence").$type<Evidence>().notNull(),
  language: text("language"),
  // dataset rows are rebuilt by `npm run timeline:build`; live rows come from ingest, agents and decisions.
  origin: text("origin").notNull().default("dataset"),
}, (table) => [
  index("timeline_order_time_idx").on(table.orderId, table.occurredAt),
  index("timeline_source_idx").on(table.source),
])

export const facts = pgTable("facts", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  subject: text("subject").notNull(),
  value: text("value").notNull(),
  status: text("status").notNull(), // claimed | verified | superseded
  sourceEntryId: text("source_entry_id").notNull(),
  statedByLabel: text("stated_by_label").notNull(),
  statedAt: timestamp("stated_at", { withTimezone: true }).notNull(),
  supersededBy: text("superseded_by"),
  kind: text("kind").notNull(), // fact | agreement
  // dataset: written by code from structured records; classifier: extracted from a message.
  origin: text("origin").notNull().default("dataset"),
}, (table) => [index("facts_order_idx").on(table.orderId)])

export type ModelUsage = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }

export const agentRuns = pgTable("agent_runs", {
  id: text("id").primaryKey(),
  orderId: text("order_id"),
  agent: text("agent").notNull(),
  model: text("model"),
  trigger: text("trigger").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull(), // running | waiting_driver | waiting_site | waiting_person | done | failed
  outcomeSummary: text("outcome_summary"),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  // Computed in code from the prices in lib/models.ts, per model call.
  costUsd: doublePrecision("cost_usd").notNull().default(0),
  // Why the run moved to a stronger model, when it did ("Driver's words and GPS disagree").
  escalation: text("escalation"),
  // Calls, tokens and cost per model ({"claude-sonnet-5-5": {calls, input, ...}}): a run can use several.
  modelUsage: jsonb("model_usage").$type<Record<string, ModelUsage>>(),
  // The Narrator's one plain sentence for the Agents view, rewritten when the run pauses or ends.
  narration: text("narration"),
  // Real time the agent spent working (model calls, tools, simulated replies), not time waiting for a person.
  wallMs: integer("wall_ms").notNull().default(0),
  // Demo: this run is a recorded run played back at its real speed, not a live one.
  replay: boolean("replay").notNull().default(false),
  // A paused run's conversation and the questions it waits on, so a reply can resume it.
  state: jsonb("state").$type<Record<string, unknown>>(),
}, (table) => [index("agent_runs_order_idx").on(table.orderId, table.startedAt)])

export const agentSteps = pgTable("agent_steps", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  idx: integer("idx").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  type: text("type").notNull(), // thought | tool_call | tool_result | message
  tool: text("tool"),
  input: jsonb("input"),
  output: jsonb("output"),
  summary: text("summary"),
}, (table) => [index("agent_steps_run_idx").on(table.runId, table.idx)])

export type CardFinding = {
  text: string; source_entry_id: string; source_label: string; at: string
  /** A second record, when the finding combines two (GPS km to go against a planning distance). */
  also?: { source_entry_id: string; source_label: string; at: string } | null
}
export type CardProposal = { action: string; params: Record<string, unknown>; effect_text: string; requires_approval_reason: string | null; cost_eur?: number | null }
/** One thing the Executor does when an option is approved. An option can hold several (ferry + hotel). */
export type CardStep = { action: string; params: Record<string, unknown> }
export type CardOption = {
  id: string; label: string; action: string; params: Record<string, unknown>
  /** Agent cards: everything the option does, in order. `action`/`params` repeat the first step. */
  steps?: CardStep[]
  /** What happens when this option is chosen, in one sentence. */
  effect_text?: string
  /** approve | reject | answer: how the decision is recorded. */
  kind?: "approve" | "reject" | "answer"
}
export type VerifierNote = { finding: number | null; ok: boolean; note: string }

export const cards = pgTable("cards", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  runId: text("run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  kind: text("kind").notNull(), // decision | question
  status: text("status").notNull(), // open | approved | rejected | answered | expired
  headline: text("headline").notNull(),
  whatHappened: text("what_happened").notNull(),
  findings: jsonb("findings").$type<CardFinding[]>().notNull(),
  proposal: jsonb("proposal").$type<CardProposal | null>(),
  options: jsonb("options").$type<CardOption[]>().notNull(),
  consequenceAt: timestamp("consequence_at", { withTimezone: true }),
  consequenceText: text("consequence_text"),
  severity: text("severity").notNull(), // safety | high | normal
  verifierNotes: jsonb("verifier_notes").$type<VerifierNote[]>(),
  // alert: a temporary card built by code from a dataset alert (phase 2); agent: written by an agent run.
  origin: text("origin").notNull().default("agent"),
}, (table) => [index("cards_status_idx").on(table.status, table.orderId)])

export const decisions = pgTable("decisions", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  actor: text("actor").notNull(),
  choice: text("choice").notNull(),
  replyText: text("reply_text"),
  executedEffect: jsonb("executed_effect").$type<ExecutedEffect>(),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  // The undo window is a person's reaction time, so it is measured in real seconds (wall clock), not on the
  // simulated clock. Everything the decision records (decided_at, the effect's entries) uses the simulated clock.
  executeAfter: timestamp("execute_after", { withTimezone: true }),
  // Set when the decision was carried out: the Executor ran, the agent got the reply, or the rejection was filed.
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
}, (table) => [index("decisions_card_idx").on(table.cardId)])

/** What the Executor did for one approved option, step by step. */
export type ExecutedEffect = {
  ok: boolean
  steps: { action: string; ok: boolean; summary: string; entryId: string | null; error?: string }[]
  /** Simulated bookings made, shown on the order with the dataset's reservations. */
  bookings: { kind: string; summary: string; departureAt: string | null; cutoffAt: string | null; zone: string | null; entryId: string; reference: string; priceCents: number | null }[]
  /** Pickup or delivery windows that were changed. */
  windows: { key: "pickup_slot" | "delivery_promise"; start: string; end: string | null; zone: string | null; place: string | null; entryId: string }[]
  /** Alerts, incidents and earlier agent proposals this decision dealt with; the order no longer lists them as open. */
  handled?: { kind: "alert" | "incident" | "proposal"; id: string; label: string }[]
}

export const policies = pgTable("policies", {
  action: text("action").primaryKey(),
  level: text("level").notNull(), // auto | approval | never
  approvedUnchangedCount: integer("approved_unchanged_count").notNull().default(0),
  decidedCount: integer("decided_count").notNull().default(0),
  note: text("note"),
})

export const evalCases = pgTable("eval_cases", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  caseSnapshot: jsonb("case_snapshot").notNull(),
  agentProposal: jsonb("agent_proposal"),
  humanCorrection: jsonb("human_correction"),
  lastResult: text("last_result"),
})

/** Scripted or typed demo events that the ingest endpoint turns into timeline entries. */
export const demoEvents = pgTable("demo_events", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  orderId: text("order_id"),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
})

/** The simulated clock. One row; see lib/clock.ts. */
export const simClock = pgTable("sim_clock", {
  id: text("id").primaryKey(),
  nowAt: timestamp("now_at", { withTimezone: true }).notNull(),
})

/** One searchable document per order, rebuilt with the timeline. */
export const searchDocuments = pgTable("search_documents", {
  orderId: text("order_id").primaryKey(),
  reference: text("reference").notNull(),
  content: text("content").notNull(),
  tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('simple', content)`),
}, (table) => [index("search_documents_tsv_idx").using("gin", table.tsv)])


/** Demo switches (SPEC 8.6), such as whether the simulated driver answers agent questions. Key/value. */
export const demoSettings = pgTable("demo_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
})
