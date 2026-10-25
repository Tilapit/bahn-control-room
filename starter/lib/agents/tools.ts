// The Investigator's tools (SPEC 7). Reading, asking and looking up are free and
// need no approval; code checks the policy table anyway. Every look-up that brings
// in new information writes a timeline entry, so a card can cite it and a person
// can see what the agent did. There is no tool that contacts a customer.

import type Anthropic from "@anthropic-ai/sdk"
import { type CaseFile, entriesById, getCase, getCases, search, timeline } from "../case"
import { now as clockNow } from "../clock"
import { MODELS, type Usage } from "../models"
import { levelFor, PROPOSABLE } from "../policies"
import { orderView } from "../queue"
import { zoneOfCity } from "../geo"
import { at, clock, zoneShort } from "../time"
import { money } from "../words"
import { caseText, timelineText } from "./case-text"
import { writeEntry } from "./entries"
import { describeFerry, ferryBookingStatus, ferryOptions, findBackupDrivers, findRepairShops, hotelOptions, travelOptions } from "./mocks"
import type { Refs } from "./refs"
import type { Party } from "./scenarios"

export const AGENT_LABEL = "Investigator agent"

export type Lookup = { kind: "ferry" | "hotel" | "travel" | "shop" | "driver"; label: string; priceCents: number | null; entryId: string; details: Record<string, unknown> }

export type RunCtx = {
  runId: string
  orderId: string
  reference: string
  model: string
  refs: Refs
  lookups: Record<string, Lookup>
  verifierRounds: number
  escalation: string | null
  /** The tool_call step being executed: the evidence for entries the tool writes. */
  stepId: string
  file: CaseFile | null
  /** Model calls made inside tools (Verifier), added to the run's tokens and cost. */
  usageExtra: { model: string; usage: Usage; what: string }[]
  /** The card being put together with add_finding and add_step; propose builds it and clears it. */
  draft: CardDraft
  /** add_finding or add_step calls that failed in the current turn: propose in the same turn waits for the fix. */
  turnErrors: string[]
  /** Every order this run covers (one cause, several orders); just the run's own order otherwise. */
  group: string[]
  /** Why the run started: a Monitor rule's finding, a message, the backfill. */
  trigger: string
  /** Set by the Monitor's no-reply rule: nobody answered since this time ("10:42"); the card must say so. */
  noReplySince: string | null
}

export type DraftFinding = { text: string; source: string; also: string | null; entryId: string; alsoId: string | null }
export type DraftStep = { option: number; action: string; params: Record<string, unknown> }
export type DraftAffected = { orderId: string; reference: string; car: string; effect: string }
export type CardDraft = { findings: DraftFinding[]; steps: DraftStep[]; affected: DraftAffected[] }
export const emptyDraft = (): CardDraft => ({ findings: [], steps: [], affected: [] })

export type ToolOutcome = {
  content: string
  output?: unknown
  summary: string
  isError?: boolean
  pause?: { party: Party; question: string; questionEntryId: string; side?: "pickup" | "delivery"; orderId?: string }
  finish?: { kind: "card"; cardId: string; summary: string } | { kind: "resolved"; summary: string; nextCheckAt: Date | null }
  switchModel?: { model: string; reason: string }
}

const error = (content: string, summary: string): ToolOutcome => ({ content, summary, isError: true })

async function caseOf(ctx: RunCtx, reference?: string | null): Promise<CaseFile | null> {
  if (!reference || reference.toUpperCase() === ctx.reference) {
    ctx.file = await getCase(ctx.orderId)
    return ctx.file
  }
  return getCase(reference)
}

/** The case of an order this run covers: its own order when none is named. Null for an order outside the run. */
async function groupCase(ctx: RunCtx, reference: string): Promise<CaseFile | null> {
  if (!reference || reference.toUpperCase() === ctx.reference) return ctx.file ?? await caseOf(ctx)
  const file = await getCase(reference)
  return file && ctx.group.includes(file.order.id) ? file : null
}

function parseTime(value: unknown, fallback: Date): Date {
  if (typeof value !== "string" || !value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date
}

async function lookupEntry(ctx: RunCtx, input: { source: string; author: string; summary: string; body: string; status?: string | null }): Promise<string> {
  return writeEntry({
    orderId: ctx.orderId, at: await clockNow(), source: input.source, channel: "agent_lookup", authorType: "agent", authorLabel: input.author,
    kind: input.source === "quote" ? "quote" : "event", summary: input.summary, body: input.body, status: input.status ?? null,
    evidence: { table: "agent_steps", id: ctx.stepId },
  })
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const ORDER = { type: "string", description: "Order reference, such as CD-420322. Leave out for the order you are investigating." }

/** The params an action can take, as flat fields of add_step. Each action uses only some of them. */
const STEP_PARAMS = {
  id: { type: "string", description: "The option id, driver id or shop id exactly as a look-up printed it." },
  name: { type: "string", description: "switch_driver: the new driver's name." },
  to: { type: "string", description: "Who gets the message or call; for book_tow, workshop or delivery." },
  text: { type: "string", description: "The full message, what to ask on the call, or what changes, in plain words." },
  start: { type: "string", description: "ISO time." },
  end: { type: "string", description: "ISO time." },
  amount_eur: { type: "number" },
  minutes: { type: "integer" },
  order: { type: "string", description: "Only when the card covers several orders: the order this action is for, such as CD-420692." },
}
export const STEP_PARAM_KEYS = Object.keys(STEP_PARAMS)

export const TOOL_DEFINITIONS: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_case",
    description: "Read the order's case file: car, route, driver, customer, key times, what was agreed, open alerts and tasks, bookings and quotes, last GPS, and the most recent timeline entries. Each line ends with a source handle such as [E12] that you cite in findings. Free. Always call it first.",
    input_schema: { type: "object", properties: { order: ORDER } },
  },
  {
    name: "timeline",
    description: "Older timeline entries of an order, oldest first, from a time on. Free. Use only when get_case does not reach back far enough.",
    input_schema: { type: "object", properties: { order: ORDER, since: { type: "string", description: "ISO time, such as 2026-10-20T00:00:00Z" } }, required: ["since"] },
  },
  {
    name: "search",
    description: "Search all orders by reference, plate, car, customer, driver, city or words in messages. Free. Use when another order may be involved.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "ask_driver",
    description: "Send the order's driver a chat message and wait for the reply. The run pauses until the driver answers; the reply comes back as this tool's result with a source handle. Ask everything you need in one short message. Free, no approval needed.",
    input_schema: { type: "object", properties: { question: { type: "string", description: "The message to the driver, as they will read it." }, order: ORDER }, required: ["question"] },
  },
  {
    name: "ask_site",
    description: "Send the pickup or delivery site's desk a message and wait for the reply. The run pauses until the site answers. Sites are not customers. Free, no approval needed.",
    input_schema: {
      type: "object",
      properties: { site: { type: "string", enum: ["pickup", "delivery"] }, question: { type: "string", description: "The message to the site desk." }, order: ORDER },
      required: ["site", "question"],
    },
  },
  {
    name: "ferry_booking_status",
    description: "Ask the ferry line what it has on file for this car: confirmed bookings, and what happened to a booking request that timed out or failed. Call it before proposing any new ferry booking. Free.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "ferry_options",
    description: "Current sailings on the order's ferry route after a time, with price and vehicle space as of now. Results are quotes and availability checks, never bookings. Each sailing has an option id for book_ferry or change_ferry_booking. Free.",
    input_schema: { type: "object", properties: { after: { type: "string", description: "ISO time; sailings departing after it. Default: now." } } },
  },
  {
    name: "hotel_options",
    description: "Hotels for the driver in a city for a stay. Quotes, not bookings. Each has an option id for book_hotel. Free.",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" }, check_in: { type: "string", description: "ISO time" }, check_out: { type: "string", description: "ISO time" } },
      required: ["city", "check_in", "check_out"],
    },
  },
  {
    name: "travel_options",
    description: "Trains and flights for the driver between two cities after a time. Quotes, not bookings. Each has an option id for book_driver_travel. Free.",
    input_schema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" }, after: { type: "string", description: "ISO time" } },
      required: ["from", "to", "after"],
    },
  },
  {
    name: "find_repair_shops",
    description: "Recovery services and workshops near a place, with tow times and price estimates. The place is usually the driver's description, so it is not a verified position. Each has a shop id for book_tow or approve_repair_cost. Free.",
    input_schema: { type: "object", properties: { near: { type: "string", description: "Where the car is, in words, such as 'A7 northbound, 40 km south of Hannover'." } }, required: ["near"] },
  },
  {
    name: "find_backup_drivers",
    description: "Active drivers who live in the pickup city and have no other gig in the records. They have not been asked yet. Each has a driver id for switch_driver. Free.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "check_disruptions",
    description: "Read the disruption feed: strikes, protests and road closures, with who reported each one and when, and which orders code matched to them. A notice is the source's report, not something a driver confirmed. Free.",
    input_schema: {
      type: "object",
      properties: {
        region: { type: "string", description: "A city, country or road in words, such as 'Lille' or 'Germany'. Leave out for every notice." },
        from: { type: "string", description: "ISO time; notices that run after it. Default: now." },
        to: { type: "string", description: "ISO time; notices that start before it. Default: three days from now." },
      },
    },
  },
  {
    name: "find_similar_decisions",
    description: "Past decisions people made on the same kind of action in a similar situation: up to 3, each with what was proposed, whether it was approved unchanged, changed or rejected and why, and whether it worked. Call it once before you propose a booking, a cost or a change, so you do not repeat what people rejected before. Free.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "The action you are about to propose, as in add_step: book_ferry, change_ferry_booking, switch_driver, message_customer, …" },
        situation: { type: "string", description: "The order's problem in a few words, such as 'ferry sold out' or 'red warning light'." },
      },
      required: ["action"],
    },
  },
  {
    name: "escalate",
    description: "Hand the investigation to the senior model when two sources disagree about something that decides the case, a person's safety is in question, or the proposal would cost more than €500. Everything you did so far is kept.",
    input_schema: { type: "object", properties: { reason: { type: "string", description: "One sentence, such as: the driver says they are at the terminal but GPS shows 1,772 km to go." } }, required: ["reason"] },
  },
  {
    name: "add_finding",
    description: "Add one finding to the card you are about to propose: one fact in one sentence, with the handle of the entry that says it. Call it once per finding, three to seven times, most important first, in the same turn as add_step and propose. Code checks the source at once and tells you if the finding was not added.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "One fact, one plain sentence." },
        source: { type: "string", description: "The handle of the entry that says it, from a tool result, such as E12." },
        also: { type: "string", description: "Optional second handle, only when the finding combines two records with plain arithmetic, such as GPS km to go and a planning distance." },
      },
      required: ["text", "source"],
    },
  },
  {
    name: "add_affected_order",
    description: "Only when one cause touches several orders: put one order on the card, with what the cause does to it in one sentence. Call it once for every order the run covers, the run's own order too. Then the card covers all of them and one approval carries out the steps for each.",
    input_schema: {
      type: "object",
      properties: {
        order: { type: "string", description: "The order reference, such as CD-420692." },
        effect: { type: "string", description: "One sentence: what the cause means for this order, such as 'Delivery in Lille on Mon 26 Oct falls inside the blockade; no driver booked yet.'" },
      },
      required: ["order", "effect"],
    },
  },
  {
    name: "add_step",
    description: "Add one action to an option of the card you are about to propose. Call it once per action, in the order they should happen. Option 1 is your proposal. A question card has no steps. Code checks the action and its look-up id at once and tells you if the step was not added.",
    input_schema: {
      type: "object",
      properties: {
        option: { type: "integer", enum: [1, 2, 3], description: "The option this action belongs to." },
        action: { type: "string", enum: PROPOSABLE },
        ...STEP_PARAMS,
      },
      required: ["option", "action"],
    },
  },
  {
    name: "propose",
    description: "Put the card in front of an operations person and end your run. The card is built from the findings and steps you added since your last propose call; send them in the same turn, before this call. Code checks every source and action, and a verifier checks each claim against its source; if they find problems, nothing is shown, the findings and steps are cleared, and you get the problems back to fix.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["decision", "question"] },
        headline: { type: "string", description: "What happened, at most 70 characters, without the car name." },
        what_happened: { type: "string", description: "One or two sentences." },
        option_1_label: { type: "string", description: "Button text of your proposal, saying exactly what happens." },
        option_1_effect: { type: "string", description: "One sentence: what the system does after the click, and what it does not do." },
        option_2_label: { type: "string", description: "Optional real alternative: its button text." },
        option_2_effect: { type: "string" },
        option_3_label: { type: "string", description: "Optional second alternative: its button text." },
        option_3_effect: { type: "string" },
        reject_label: { type: "string", description: "Button text for no, saying what happens." },
        cost_eur: { type: ["number", "null"], description: "Total new cost of option 1 in euros, or null." },
      },
      required: ["kind", "headline", "what_happened", "option_1_label", "option_1_effect", "reject_label"],
    },
  },
  {
    name: "resolve",
    description: "End your run without a card, because nothing needs a person: the records explain the signal, or someone already owns the next step and nothing is lost before they act. Cite the entries that explain it.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One plain sentence for the Agents view, such as: Checked a route deviation; explained by an agreement in support chat at 12:04." },
        explained_by: { type: "array", items: { type: "string" }, description: "Source handles, such as E12." },
        check_again_minutes: { type: ["integer", "null"], description: "When to look again, or null." },
      },
      required: ["summary", "explained_by"],
    },
  },
]

// A card is built from flat calls: add_finding and add_step once per item, then propose with plain fields.
// The earlier single propose call nested findings and options inside it, and its first call arrived
// malformed in most runs (lists sent as text). Not strict: strict mode garbled card text in testing.
// Cache the tool definitions with the system prompt (SPEC 7). The marker on the last tool covers all of them.
TOOL_DEFINITIONS[TOOL_DEFINITIONS.length - 1] = { ...TOOL_DEFINITIONS[TOOL_DEFINITIONS.length - 1], cache_control: { type: "ephemeral" } }

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type Input = Record<string, unknown>
type Executor = (ctx: RunCtx, input: Input) => Promise<ToolOutcome>

const text = (value: unknown) => typeof value === "string" ? value.trim() : ""

const EXECUTORS: Record<string, Executor> = {
  async get_case(ctx, input) {
    const file = await caseOf(ctx, text(input.order) || null)
    if (!file) return error(`No order ${text(input.order)}.`, "Looked for an order that does not exist")
    return { content: caseText(file, ctx.refs), summary: `Read the order's records (${file.order.reference})` }
  },

  async timeline(ctx, input) {
    const file = await caseOf(ctx, text(input.order) || null)
    if (!file) return error(`No order ${text(input.order)}.`, "Looked for an order that does not exist")
    const since = parseTime(input.since, new Date(0))
    const items = await timeline(file.order.id, since)
    return { content: timelineText(items, orderView(file).zone, ctx.refs), output: { count: items.length }, summary: `Read the timeline of ${file.order.reference} from ${at(since, orderView(file).zone)}` }
  },

  async search(ctx, input) {
    const hits = await search(text(input.query), 8)
    const lines = hits.map((hit) => `${hit.reference} · ${hit.car} · ${hit.route} · ${hit.customer}${hit.snippet ? ` · ${hit.snippet.source}, ${hit.snippet.when}: “${hit.snippet.text.replace(/[«»]/g, "")}”` : ""}`)
    return { content: lines.join("\n") || "No orders match.", output: hits, summary: `Searched for “${text(input.query)}”` }
  },

  async ask_driver(ctx, input) {
    const question = text(input.question)
    if (await levelFor("ask_driver") !== "auto") return error("Asking the driver needs a person's approval right now. Propose it instead.", "Not allowed to ask the driver")
    const file = await groupCase(ctx, text(input.order))
    if (!file) return error(`${text(input.order)} is not one of the orders this run covers.`, "Asked about an order outside the run")
    if (!file.order.driver) return error(`No driver is booked on ${file.order.reference}, so there is nobody to ask.`, "No driver to ask")
    if (!question) return error("Write the question.", "Empty question")
    const entryId = await writeEntry({
      orderId: file.order.id, at: await clockNow(), source: "driver_chat", channel: "driver_chat", authorType: "agent", authorLabel: AGENT_LABEL,
      kind: "message", summary: question, body: question, visibility: "public", evidence: { table: "agent_steps", id: ctx.stepId },
    })
    const other = file.order.id !== ctx.orderId ? ` on ${file.order.reference}` : ""
    return { content: "", summary: `Asked the driver${other}: “${question}”`, pause: { party: "driver", question, questionEntryId: entryId, orderId: file.order.id } }
  },

  async ask_site(ctx, input) {
    const question = text(input.question)
    const side = input.site === "delivery" ? "delivery" : "pickup"
    if (await levelFor("ask_site") !== "auto") return error("Asking the site needs a person's approval right now. Propose it instead.", "Not allowed to ask the site")
    if (!question) return error("Write the question.", "Empty question")
    const file = await groupCase(ctx, text(input.order))
    if (!file) return error(`${text(input.order)} is not one of the orders this run covers.`, "Asked about an order outside the run")
    const place = side === "pickup" ? file.order.route.from : file.order.route.to
    if (place?.kind === "private") return error(`The ${side} is a private address, not a site with a desk. Its contact may be the customer's: do not contact them; propose it instead.`, "No site desk to ask")
    const entryId = await writeEntry({
      orderId: file.order.id, at: await clockNow(), source: "support", channel: "site_chat", authorType: "agent", authorLabel: AGENT_LABEL,
      kind: "message", summary: question, body: question, visibility: "public", evidence: { table: "agent_steps", id: ctx.stepId },
    })
    return { content: "", summary: `Asked the ${side} site (${place?.name ?? "site"}): “${question}”`, pause: { party: "site", question, questionEntryId: entryId, side, orderId: file.order.id } }
  },

  async ferry_booking_status(ctx) {
    const status = await ferryBookingStatus(ctx.orderId)
    const entryId = await lookupEntry(ctx, { source: "agent", author: "Ferry line lookup", summary: status.summary, body: status.text })
    return { content: `${status.text}\nSource: ${ctx.refs.cite(entryId)}`, output: status, summary: `Asked the ferry line what it has on file: ${status.summary.charAt(0).toLowerCase()}${status.summary.slice(1)}` }
  },

  async ferry_options(ctx, input) {
    const now = await clockNow()
    const after = parseTime(input.after, now)
    const result = await ferryOptions(ctx.orderId, after, now)
    if (!result.options.length) return { content: `No sailings on ${result.route} after ${at(after, "Europe/Berlin")} in the next days.`, summary: "Checked ferry sailings: none found" }
    const lines = result.options.map((option) => `- ${option.id}: ${describeFerry(option)}`)
    const short = result.options.map((option) => `${at(option.departureAt, "Europe/Berlin").replace(/ CES?T$/, "")} ${option.state === "quote" ? `${money(option.priceCents, "EUR")} (quote, not booked)` : option.state}`).join("; ")
    const entryId = await lookupEntry(ctx, {
      source: "quote", author: `${result.options[0].provider} (checked by the agent)`, status: result.options.some((option) => option.state === "quote") ? "quote" : null,
      summary: `Ferry re-check, ${result.route}: ${short}`, body: lines.map((line) => line.replace(/^- \S+: /, "")).join("\n"),
    })
    for (const option of result.options) {
      ctx.lookups[option.id] = { kind: "ferry", label: describeFerry(option), priceCents: option.priceCents, entryId, details: option as unknown as Record<string, unknown> }
    }
    return {
      content: `Sailings ${result.route}, checked ${clock(now, "Europe/Berlin")} Hamburg time. These are quotes and availability checks, not bookings.\n${lines.join("\n")}\nSource: ${ctx.refs.cite(entryId)}`,
      output: result, summary: `Checked ferry sailings after ${at(after, "Europe/Berlin")}: ${short}`,
    }
  },

  async hotel_options(ctx, input) {
    const city = text(input.city)
    const checkIn = parseTime(input.check_in, await clockNow()).toISOString()
    const checkOut = parseTime(input.check_out, new Date(new Date(checkIn).getTime() + 12 * 3600_000)).toISOString()
    const options = hotelOptions(city, checkIn, checkOut)
    const zone = zoneOfCity(city) ?? orderView(ctx.file ?? (await caseOf(ctx))!).zone
    const lines = options.map((option) => `- ${option.id}: ${option.name}, ${money(option.priceCents, "EUR")} for ${at(option.checkIn, zone)} to ${at(option.checkOut, zone)}, ${option.note} (quote, not booked)`)
    const entryId = await lookupEntry(ctx, {
      source: "quote", author: "Hotel search (by the agent)", status: "quote",
      summary: `Hotel quotes in ${city}: ${options.map((option) => `${option.name} ${money(option.priceCents, "EUR")}`).join(", ")}`, body: lines.map((line) => line.replace(/^- \S+: /, "")).join("\n"),
    })
    for (const option of options) ctx.lookups[option.id] = { kind: "hotel", label: `${option.name}, ${at(option.checkIn, zone)} to ${at(option.checkOut, zone)}`, priceCents: option.priceCents, entryId, details: option as unknown as Record<string, unknown> }
    return { content: `Hotels in ${city}. Quotes, not bookings.\n${lines.join("\n")}\nSource: ${ctx.refs.cite(entryId)}`, output: options, summary: `Looked up hotels in ${city}` }
  },

  async travel_options(ctx, input) {
    const from = text(input.from)
    const to = text(input.to)
    const after = parseTime(input.after, await clockNow())
    const options = await travelOptions(from, to, after)
    // Each time in its own place's zone: a Helsinki to Pori train in Finnish time, wherever the car is.
    const zone = zoneOfCity(from) ?? orderView(ctx.file ?? (await caseOf(ctx))!).zone
    const lines = options.map((option) => `- ${option.id}: ${option.kind} by ${option.provider}, ${option.from} to ${option.to}, departs ${at(option.departureAt, zoneOfCity(option.from) ?? zone)}, arrives ${at(option.arrivalAt, zoneOfCity(option.to) ?? zone)}, ${money(option.priceCents, "EUR")} (quote, not booked)${option.note ? `; ${option.note}` : ""}`)
    const entryId = await lookupEntry(ctx, {
      source: "quote", author: "Travel search (by the agent)", status: "quote",
      summary: `Driver travel quotes ${from} to ${to}: ${options.map((option) => `${option.kind} ${clock(option.departureAt, zoneOfCity(option.from) ?? zone)} ${money(option.priceCents, "EUR")}`).join(", ")} (${zoneShort(after, zone)})`, body: lines.map((line) => line.replace(/^- \S+: /, "")).join("\n"),
    })
    for (const option of options) ctx.lookups[option.id] = { kind: "travel", label: `${option.kind} ${option.from} to ${option.to}, ${at(option.departureAt, zoneOfCity(option.from) ?? zone)}`, priceCents: option.priceCents, entryId, details: option as unknown as Record<string, unknown> }
    return { content: `Trains and flights. Quotes, not bookings.\n${lines.join("\n") || "- none found"}\nSource: ${ctx.refs.cite(entryId)}`, output: options, summary: `Looked up trains and flights from ${from} to ${to}` }
  },

  async find_repair_shops(ctx, input) {
    const near = text(input.near)
    const file = ctx.file ?? await caseOf(ctx)
    const shops = findRepairShops(near, file?.plan.lastPosition?.kmToGo ?? null)
    const lines = shops.map((shop) => `- ${shop.id}: ${shop.name}, ${shop.kind}, ${shop.distanceKm} km away${shop.towEtaMinutes ? `, tow truck in about ${shop.towEtaMinutes} min` : ""}${shop.towToShopCents ? `, tow to their workshop about ${money(shop.towToShopCents, "EUR")}` : ""}${shop.towToDeliveryCents ? `, tow to the delivery address in ${file?.order.route.to?.city ?? "the delivery city"} about ${money(shop.towToDeliveryCents, "EUR")}` : ""}. ${shop.note}`)
    const entryId = await lookupEntry(ctx, {
      source: "agent", author: "Repair shop lookup", summary: `Recovery and workshops near ${near}: ${shops.map((shop) => shop.name).join(", ")}`, body: lines.map((line) => line.replace(/^- \S+: /, "")).join("\n"),
    })
    for (const shop of shops) ctx.lookups[shop.id] = { kind: "shop", label: shop.name, priceCents: shop.towToShopCents || null, entryId, details: shop as unknown as Record<string, unknown> }
    return { content: `Near "${near}" (the place as described, not a verified position). Prices are estimates, not bookings.\n${lines.join("\n")}\nSource: ${ctx.refs.cite(entryId)}`, output: shops, summary: `Looked up recovery and workshops near ${near}` }
  },

  async find_backup_drivers(ctx) {
    const result = await findBackupDrivers(ctx.orderId)
    if (!result.options.length) return { content: `No free drivers live in ${result.city ?? "the pickup city"}.`, summary: "Looked for backup drivers: none found" }
    const lines = result.options.map((driver) => `- ${driver.id}: ${driver.name}, ${driver.home}; ${driver.note}`)
    const entryId = await lookupEntry(ctx, {
      source: "agent", author: "Driver pool lookup", summary: `Possible backup drivers in ${result.city}: ${result.options.map((driver) => driver.name).join(", ")} (not asked yet)`, body: lines.map((line) => line.replace(/^- \S+: /, "")).join("\n"),
    })
    for (const driver of result.options) ctx.lookups[driver.id] = { kind: "driver", label: driver.name, priceCents: null, entryId, details: driver as unknown as Record<string, unknown> }
    return { content: `Drivers who could take the gig. None has been asked; availability needs their yes.\n${lines.join("\n")}\nSource: ${ctx.refs.cite(entryId)}`, output: result, summary: `Looked for backup drivers in ${result.city}` }
  },

  async check_disruptions(ctx, input) {
    const { activeDisruptions, matchDisruption, noticeLine } = await import("../disruptions")
    const now = await clockNow()
    const from = parseTime(input.from, now)
    const to = parseTime(input.to, new Date(now.getTime() + 3 * 86_400_000))
    const region = text(input.region).toLowerCase()
    const notices = (await activeDisruptions(now)).filter((notice) => notice.startsAt <= to && notice.endsAt >= from)
      .filter((notice) => !region || `${notice.region} ${notice.title} ${notice.detail}`.toLowerCase().includes(region))
    if (!notices.length) return { content: `No disruption notices${region ? ` for "${text(input.region)}"` : ""} between ${at(from, "UTC")} and ${at(to, "UTC")}.`, summary: `Checked the disruption feed${region ? ` for ${text(input.region)}` : ""}: nothing` }
    const all = await getCases()
    const lines: string[] = []
    for (const notice of notices) {
      // Cite the notice as it landed on this run's orders; if it is not on one of them, the look-up itself is the record.
      const onOrder = ctx.group.map((id) => `disruptions:${notice.id}:${id}`)
      const known = [...(await entriesById(onOrder)).keys()][0]
      const entryId = known ?? await lookupEntry(ctx, { source: "alert", author: notice.sourceLabel, summary: `${notice.sourceLabel}: ${notice.title}`, body: noticeLine(notice), status: "signal" })
      const matches = matchDisruption(notice, all, now)
      lines.push(`- ${noticeLine(notice)} ${ctx.refs.cite(entryId)}\n  Orders code matched to it: ${matches.length ? matches.map((match) => `${match.file.order.reference} (${match.effect})`).join("; ") : "none"}`)
    }
    return { content: `Disruption feed, checked ${at(now, "UTC")}. Each notice is what its source reports; no driver has confirmed it unless a message says so.\n${lines.join("\n")}`, summary: `Checked the disruption feed${region ? ` for ${text(input.region)}` : ""}: ${notices.map((notice) => notice.title).join("; ")}` }
  },

  async find_similar_decisions(ctx, input) {
    const { findSimilar, similarText } = await import("../learning")
    const { situationOf } = await import("../outcomes")
    const action = text(input.action)
    if (!action) return error("Say which action you are about to propose.", "Looked for similar past decisions without an action")
    const file = ctx.file ?? await getCase(ctx.orderId)
    // What the order's problem is: the agent's words, or else the open alerts, tasks and incidents.
    const open = file ? [...file.open.alerts.map((item) => item.label), ...file.open.tasks.map((item) => item.label), ...file.open.incidents.map((item) => item.label)].join(" ") : ""
    const situation = situationOf(text(input.situation) || open)
    const cases = await findSimilar({ action, situation, excludeOrderId: ctx.orderId })
    return {
      content: `Past decisions on "${action}" (${situation.replace(/_/g, " ")}), closest first. They are other orders' decisions: let them shape your proposal, and do not cite them as findings on this order.\n${similarText(cases)}`,
      output: cases, summary: cases.length ? `Looked up ${cases.length} similar past decision${cases.length === 1 ? "" : "s"}` : "Looked up similar past decisions: none yet",
    }
  },

  async escalate(ctx, input) {
    const reason = text(input.reason) || "The case needs the senior model."
    if (ctx.model === MODELS.opus) return { content: "You are already the senior model. Continue.", summary: "Asked to escalate, already on the senior model" }
    return { content: "The investigation is now with the senior model, with everything done so far. Continue the work: ask, look up and then propose or resolve.", summary: `Handed the case to the senior model: ${reason}`, switchModel: { model: MODELS.opus, reason } }
  },
}

export async function executeTool(ctx: RunCtx, name: string, input: Input): Promise<ToolOutcome> {
  // Ops took the order over: no tool runs on it, not even a question or a look-up, until a person hands it back.
  const { agentBlockedOn } = await import("../takeover")
  const blocked = await agentBlockedOn(ctx.group.length ? ctx.group : [ctx.orderId])
  if (blocked) return error(`${blocked} You cannot act on it until they hand it back: no questions, look-ups or proposals.`, "Stopped: a person has taken this order over")
  if (name === "add_finding") return (await import("./propose")).addFinding(ctx, input)
  if (name === "add_step") return (await import("./propose")).addStep(ctx, input)
  if (name === "add_affected_order") return (await import("./propose")).addAffected(ctx, input)
  if (name === "propose") return (await import("./propose")).propose(ctx, input)
  if (name === "resolve") return (await import("./propose")).resolve(ctx, input)
  const executor = EXECUTORS[name]
  if (!executor) return error(`There is no tool called ${name}.`, `Tried a tool that does not exist (${name})`)
  try {
    return await executor(ctx, input)
  } catch (cause) {
    return error(`The tool failed: ${cause instanceof Error ? cause.message : String(cause)}`, `${name} failed`)
  }
}
