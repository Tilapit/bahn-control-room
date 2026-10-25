// The Monitor: rules in code that notice problems nobody has reported yet, and
// start an agent before a driver or customer has to say anything. Each rule writes
// what it saw as a timeline entry with a deterministic id, so it never fires twice
// for the same thing, and records a short code run for the Agents view.

import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray, like } from "drizzle-orm"
import { type CaseFile, getCases } from "./case"
import { now as clockNow, demoStart } from "./clock"
import { db } from "./db"
import { autoReplyEnabled } from "./demo"
import { activeDisruptions, matchDisruption, noticeLine } from "./disruptions"
import { addStep, createRun, updateRun } from "./agents/runs"
import { writeEntry } from "./agents/entries"
import { hasApiKey } from "./agents/llm"
import { agentRuns, type CardFinding, type CardOption, cards, timelineEntries } from "./schema"
import { openTakeovers } from "./takeover"
import { urgency } from "./urgency"
import type { RunState } from "./agents/investigator"
import { orderView } from "./queue"
import { at, clock, zoneShort } from "./time"

export const MONITOR_AGENT = "Monitor"

export type MonitorHit = { rule: string; summary: string; orders: string[]; investigatorRunId?: string | null }

type Options = {
  /** Start the Investigator for what the rules found. Off: record the hits only (no API key, or a dry run). */
  startAgents?: boolean
  /** Wait for the agents to finish (scripts); otherwise they run in the background (the app). */
  wait?: boolean
  /** Run only these rules (disruption, gig-cancelled, silent-car). Default: all. */
  only?: ("disruption" | "gig-cancelled" | "silent-car" | "no-reply")[]
  log?: (line: string) => void
}

async function existing(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  return new Set((await db.select({ id: timelineEntries.id }).from(timelineEntries).where(inArray(timelineEntries.id, ids))).map((row) => row.id))
}

/** One code run per hit, so the Agents view shows what the Monitor noticed and what it started. */
async function recordHit(file: CaseFile, now: Date, rule: string, checked: string, summary: string): Promise<string> {
  const runId = await createRun({ orderId: file.order.id, agent: MONITOR_AGENT, model: null, trigger: `Monitor rule: ${rule}`, at: now })
  await addStep(runId, 0, { at: now, type: "tool_result", tool: "monitor", input: { rule }, summary: checked })
  await updateRun(runId, { status: "done", finishedAt: now, outcomeSummary: summary, narration: summary })
  return runId
}

async function investigate(files: CaseFile[], trigger: string, options: Options): Promise<string | null> {
  if (!options.startAgents || !hasApiKey()) return null
  const { startInvestigation } = await import("./agents/investigator")
  const autoReply = await autoReplyEnabled()
  const run = startInvestigation(files[0].order.reference, { trigger, autoReply, group: files.length > 1 ? files.map((file) => file.order.id) : undefined, log: options.log })
  if (options.wait) return (await run).runId
  void run.catch((error) => console.error("monitor investigation", error))
  return "started"
}

// ---------------------------------------------------------------------------
// Rule: a disruption notice touches orders (strike, protest, road closure)
// ---------------------------------------------------------------------------

async function disruptionRule(files: CaseFile[], now: Date, options: Options): Promise<MonitorHit[]> {
  const hits: MonitorHit[] = []
  for (const notice of await activeDisruptions(now)) {
    const matches = matchDisruption(notice, files, now)
    const ids = matches.map((match) => `disruptions:${notice.id}:${match.file.order.id}`)
    const known = await existing(ids)
    const fresh = matches.filter((_, index) => !known.has(ids[index]))
    if (!fresh.length) continue
    for (const match of fresh) {
      await writeEntry({
        id: `disruptions:${notice.id}:${match.file.order.id}`,
        orderId: match.file.order.id, at: now, source: "alert", channel: "disruption_feed", authorType: "system", authorLabel: notice.sourceLabel,
        kind: "alert", status: "signal", visibility: "internal",
        summary: `${notice.sourceLabel}: ${notice.title}. ${match.effect}`,
        body: `${noticeLine(notice)}\nThis is the feed's notice, matched to this order by the Monitor. No driver or site has confirmed it.`,
        evidence: { table: "disruptions", id: notice.id },
      })
    }
    const references = fresh.map((match) => match.file.order.reference)
    const trigger = [
      `Monitor: ${notice.sourceLabel} reports "${notice.title}" (${at(notice.startsAt, notice.timezone)} to ${at(notice.endsAt, notice.timezone)}), published ${notice.publishedAt ? at(notice.publishedAt, notice.timezone) : "now"}.`,
      `Matched by code to ${fresh.length === 1 ? "one order" : `${fresh.length} orders with this one cause`}:`,
      ...fresh.map((match) => `- ${match.file.order.reference}: ${match.effect}`),
      "No driver, site or customer has reported it. Check what it means for each order before anyone is affected.",
    ].join("\n")
    const runId = await investigate(fresh.map((match) => match.file), trigger, options)
    const summary = `Matched “${notice.title}” (${notice.sourceLabel}) to ${references.join(", ")}${runId ? "; the Investigator is looking into it" : "; no agent started"}.`
    for (const match of fresh) await recordHit(match.file, now, "disruption notice", `Checked ${notice.title} against routes, pickups, deliveries and drivers' booked trains.`, summary)
    hits.push({ rule: "disruption", summary, orders: references, investigatorRunId: runId })
    options.log?.(summary)
  }
  return hits
}

// ---------------------------------------------------------------------------
// Rule: a driver took the gig, but the car is not moving (silent problem)
// ---------------------------------------------------------------------------

const HOUR = 3_600_000
/** No GPS for this long while on the road, and no word from the driver: worth asking. */
const SILENT_GPS_HOURS = 3
/** A pickup slot this far gone with no collection recorded. */
const LATE_PICKUP_MINUTES = 30

/** Someone is already on it: an open card, or an agent run that is working or waiting. */
async function attended(files: CaseFile[]): Promise<Set<string>> {
  const runs = await db.select({ orderId: agentRuns.orderId }).from(agentRuns).where(inArray(agentRuns.status, ["running", "waiting_driver", "waiting_site", "waiting_person"]))
  return new Set([...files.filter((file) => file.open.cards.length).map((file) => file.order.id), ...runs.map((run) => run.orderId ?? "")])
}

/**
 * What the silent-car rule sees on one order at this time: a deviation, a car not moving, no GPS and no word, or a
 * pickup slot passing with no collection. Null when nothing. `horizon` is where the recorded GPS data ends.
 */
export function silentSignal(file: CaseFile, now: Date, horizon: number): { id: string; seen: string } | null {
  if (!file.order.driver || file.order.driver.state === "cancelled") return null
  const zone = orderView(file).zone
  // The driver's last message (an expense claim or a photo upload is not a word about the car's progress).
  const driverSpoke = file.timeline.filter((item) => item.authorType === "driver" && item.kind === "message").map((item) => new Date(item.at).getTime()).sort((a, b) => b - a)[0] ?? 0
  let id: string | null = null
  let seen = ""
  if (file.order.stage.key === "moving") {
    const [last] = file.plan.positions
    const silentSince = last ? new Date(last.at).getTime() : file.order.pickedUpAt ? new Date(file.order.pickedUpAt).getTime() : null
    // The oldest fix in the latest run of fixes at (nearly) the same distance: no progress since then.
    let previous = last
    for (const fix of file.plan.positions.slice(1)) {
      if (last?.kmToGo == null || fix.kmToGo == null || Math.abs(fix.kmToGo - last.kmToGo) > 2) break
      previous = fix
    }
    const stuck = last && previous && previous !== last && new Date(last.at).getTime() - new Date(previous.at).getTime() >= 60 * 60_000
    // Heading away: km to go rose by 8 km or more against a fix from the last 90 minutes.
    const lower = file.plan.positions.slice(1).find((fix) => last?.kmToGo != null && fix.kmToGo != null && last.kmToGo - fix.kmToGo >= 8
      && new Date(last.at).getTime() - new Date(fix.at).getTime() <= 90 * 60_000)
    if (last && lower) {
      id = `monitor:deviation:${file.order.id}:${last.at}`
      seen = `GPS shows km to go rising from ${lower.kmToGo} km at ${at(lower.at, zone)} to ${last.kmToGo} km at ${at(last.at, zone)}: the car is moving away from ${file.order.route.to?.city ?? "the delivery address"}.`
    } else if (stuck && driverSpoke < new Date(previous.at).getTime()) {
      id = `monitor:not-moving:${file.order.id}:${last.at}`
      seen = `The car has not moved: GPS showed ${previous.kmToGo} km to go at ${at(previous.at, zone)} and ${last.kmToGo} km at ${at(last.at, zone)}, and the driver has not written since.`
    } else if (silentSince != null && horizon - silentSince >= SILENT_GPS_HOURS * HOUR && driverSpoke < silentSince) {
      id = `monitor:silent-car:${file.order.id}:${last?.at ?? "none"}`
      seen = last
        ? `The car is on the road, but the driver app has sent no position since ${at(last.at, zone)}${last.kmToGo != null ? `, when it had ${last.kmToGo} km to go` : ""}, and the driver has not written since.`
        : `The car was collected ${at(file.order.pickedUpAt, zone)}, but the driver app has sent no position since, and the driver has not written.`
    }
  } else if (file.order.stage.key === "driver_booked") {
    const slot = file.keyTimes.find((item) => item.key === "pickup_slot")
    if (!slot || file.order.pickedUpAt) return null
    const late = now.getTime() - new Date(slot.start).getTime()
    if (late < LATE_PICKUP_MINUTES * 60_000 || driverSpoke > new Date(slot.start).getTime()) return null
    id = `monitor:pickup-late:${file.order.id}:${slot.start}`
    seen = `The pickup slot in ${slot.place ?? "the pickup city"} started ${at(slot.start, slot.zone)}, ${Math.round(late / 60_000)} min ago. No collection is recorded and the driver has not written since.`
  }
  return id ? { id, seen } : null
}

async function silentCarRule(files: CaseFile[], now: Date, options: Options): Promise<MonitorHit[]> {
  const busy = await attended(files)
  // The records are a snapshot: no new GPS arrives as the demo clock moves. Silence is judged up to where the recorded
  // data ends, or every car on the road would look silent after three simulated hours.
  const horizon = Math.min(now.getTime(), (await demoStart()).getTime())
  const hits: MonitorHit[] = []
  for (const file of files) {
    if (busy.has(file.order.id)) continue
    const signal = silentSignal(file, now, horizon)
    if (!signal || (await existing([signal.id])).size) continue
    const { id, seen } = signal
    await writeEntry({
      id, orderId: file.order.id, at: now, source: "alert", channel: "monitor", authorType: "system", authorLabel: "Monitor (code)",
      kind: "alert", status: "signal", visibility: "internal", summary: seen, body: "Noticed by a rule in code. Nobody has reported a problem; this is a reason to ask, not a diagnosis.",
      evidence: { table: "timeline_entries", id },
    })
    const trigger = id.startsWith("monitor:deviation")
      ? `Monitor: ${seen} This is a route deviation. Check the order's records first: an agreement may explain it.`
      : `Monitor: ${seen} Nobody has reported a problem. Ask the driver first what is going on, then decide whether a person needs to act.`
    const runId = await investigate([file], trigger, options)
    const what = id.startsWith("monitor:pickup-late") ? "Noticed a pickup slot passing with no collection" : id.startsWith("monitor:not-moving") ? "Noticed the car has not moved"
      : id.startsWith("monitor:deviation") ? "Noticed km to go rising (a route deviation)" : "Noticed no GPS and no word from the driver"
    const summary = `${what}${runId ? id.startsWith("monitor:deviation") ? "; the Investigator is checking it" : "; the Investigator is asking the driver" : "; no agent started"}.`
    await recordHit(file, now, id.split(":")[1], seen, summary)
    hits.push({ rule: "silent-car", summary, orders: [file.order.reference], investigatorRunId: runId })
    options.log?.(`${file.order.reference}: ${summary}`)
  }
  return hits
}

// ---------------------------------------------------------------------------
// Rule: a driver cancelled a gig (silent problem): republish now, with a fee suggestion
// ---------------------------------------------------------------------------

/** The fee raise that time left suggests: the closer the pickup, the more it takes to find someone. */
export function suggestedRaise(hoursLeft: number): number {
  if (hoursLeft <= 12) return 0.3
  if (hoursLeft <= 24) return 0.2
  if (hoursLeft <= 48) return 0.1
  return 0
}

async function cancelledGigRule(files: CaseFile[], now: Date): Promise<MonitorHit[]> {
  const cancellations = await db.select().from(timelineEntries).where(and(eq(timelineEntries.channel, "gig_cancelled"), eq(timelineEntries.origin, "live")))
  const hits: MonitorHit[] = []
  for (const entry of cancellations) {
    const id = `monitor:republish:${entry.id}`
    const file = files.find((item) => item.order.id === entry.orderId)
    if (!file || (await existing([id])).size) continue
    const slot = file.keyTimes.find((item) => item.key === "pickup_slot") ?? file.keyTimes.find((item) => item.key === "pickup_planned")
    // The fee comes from the latest offer on the timeline ("Gig offered to drivers at €604"), which the card cites.
    const [offer] = await db.select().from(timelineEntries).where(and(eq(timelineEntries.orderId, file.order.id), like(timelineEntries.summary, "Gig offered to drivers at €%"))).orderBy(desc(timelineEntries.occurredAt)).limit(1)
    const fee = offer ? Number(offer.summary.replace(/^.*€([\d,]+).*$/, "$1").replace(/,/g, "")) || null : null
    const hoursLeft = slot ? (new Date(slot.start).getTime() - now.getTime()) / HOUR : Infinity
    const raise = suggestedRaise(hoursLeft)
    const raiseEur = fee ? Math.round((fee * raise) / 5) * 5 : 0
    const left = Number.isFinite(hoursLeft) ? hoursLeft >= 1 ? `${Math.round(hoursLeft)} h` : `${Math.max(0, Math.round(hoursLeft * 60))} min` : "no pickup slot recorded"
    const who = entry.authorLabel ?? "The driver"
    const runId = await recordHit(file, now, "driver cancelled a gig", `${who} cancelled the gig in the driver app. Time left to the pickup slot: ${left}.`, `Noticed ${who}'s cancellation; proposed in For you to offer the gig to drivers again${raiseEur ? ` with the fee raised by €${raiseEur}` : ""}.`)
    await writeEntry({ id, orderId: file.order.id, at: now, source: "alert", channel: "monitor", authorType: "system", authorLabel: "Monitor (code)", kind: "alert", status: "signal", visibility: "internal", summary: `Driver cancelled the gig: republish needed${slot ? ` before the pickup ${at(slot.start, slot.zone)}` : ""}.`, evidence: { table: "timeline_entries", id: entry.id } })
    const placeTime = slot ? `${slot.place ?? "the pickup"} ${at(slot.start, slot.zone)}` : "a pickup with no slot yet"
    const findings: CardFinding[] = [
      { text: `${who} cancelled the gig in the driver app.`, source_entry_id: entry.id, source_label: "Driver app", at: entry.occurredAt.toISOString() },
      ...(slot ? [{ text: `The pickup slot is ${at(slot.start, slot.zone)} in ${slot.place ?? "the pickup city"}, ${left} from now.`, source_entry_id: slot.source.entryId ?? entry.id, source_label: slot.source.chip, at: slot.source.at ?? entry.occurredAt.toISOString() }] : []),
      ...(fee && offer ? [{ text: `The gig was offered at €${fee}. With ${left} left, the rule in code suggests ${raise ? `+${Math.round(raise * 100)}% (€${raiseEur})` : "no raise"}: within 12 h +30%, within 24 h +20%, within 48 h +10%.`, source_entry_id: offer.id, source_label: "Order record", at: offer.occurredAt.toISOString() }] : []),
    ]
    const options: CardOption[] = [
      ...(raiseEur ? [{ id: "opt-1", label: `Approve: republish the gig now at €${fee! + raiseEur} (+€${raiseEur})`, action: "republish_offer", params: {}, steps: [{ action: "republish_offer", params: {} }, { action: "raise_fee", params: { amount_eur: raiseEur } }], effect_text: `Offers the gig to drivers again with the fee raised from €${fee} to €${fee! + raiseEur}; changes nothing else.`, kind: "approve" as const }] : []),
      { id: raiseEur ? "opt-2" : "opt-1", label: `Republish the gig now${fee ? ` at the same fee (€${fee})` : ""}`, action: "republish_offer", params: {}, steps: [{ action: "republish_offer", params: {} }], effect_text: "Offers the gig to drivers again; the fee stays as it was.", kind: "approve" as const },
      { id: "reject", label: "Reject: don't republish, I'll find a driver", action: "reject", params: {}, kind: "reject" as const },
    ]
    const u = urgency(file, now)
    await db.insert(cards).values({
      id: `card_${randomUUID().slice(0, 12)}`, orderId: file.order.id, runId, createdAt: now, kind: "decision", status: "open",
      headline: `${file.order.car.label}: driver cancelled the gig; pickup in ${placeTime}`,
      whatHappened: `${who} cancelled the gig in the driver app; nobody else has it. The pickup is in ${left}, so the gig should go back out now.`,
      findings, proposal: { action: "republish_offer", params: {}, effect_text: options[0].effect_text ?? "", requires_approval_reason: "it changes a booking and a cost", cost_eur: raiseEur || null },
      options, consequenceAt: u.at ? new Date(u.at) : null, consequenceText: u.sentence, severity: u.timeRisk ? "high" : "normal", verifierNotes: null, origin: "monitor", group: null,
    })
    hits.push({ rule: "gig-cancelled", summary: `Card to republish ${file.order.reference}${raiseEur ? ` with +€${raiseEur}` : ""}.`, orders: [file.order.reference] })
  }
  return hits
}

// ---------------------------------------------------------------------------
// Rule: a driver or site does not answer an agent's question
// ---------------------------------------------------------------------------

/** After the first wait (15 simulated minutes) one follow-up; 30 minutes after that, the run escalates to a person. */
const FOLLOW_UP_WAIT_MINUTES = 30

async function noReplyRule(now: Date, options: Options, taken: Set<string> = new Set()): Promise<MonitorHit[]> {
  const waiting = await db.select().from(agentRuns).where(inArray(agentRuns.status, ["waiting_driver", "waiting_site"]))
  const hits: MonitorHit[] = []
  for (const run of waiting) {
    if (!run.nextCheckAt || run.nextCheckAt > now || !run.state || !run.orderId || taken.has(run.orderId)) continue
    const state = run.state as unknown as RunState
    const pending = state.pending.filter((item) => item.party !== "person")
    if (!pending.length) continue
    const first = pending[0]
    const [question] = await db.select().from(timelineEntries).where(eq(timelineEntries.id, first.questionEntryId)).limit(1)
    const orderId = first.orderId ?? run.orderId
    const file = (await getCases([orderId]))[0]
    if (!file || !question) continue
    const zone = orderView(file).zone
    const asked = clock(question.occurredAt, zone)
    const who = first.party === "driver" ? "driver" : "site"
    const Who = who === "driver" ? "Driver" : "Site"
    if (!state.followUp) {
      // One follow-up, in the same channel, written by code: reading and asking need no approval.
      const text = `Following up on my message from ${asked}: could you reply when you can? ${first.question.length > 160 ? `${first.question.slice(0, 157)}…` : first.question}`
      await writeEntry({
        orderId, at: now, source: who === "driver" ? "driver_chat" : "support", channel: who === "driver" ? "driver_chat" : "site_chat", authorType: "agent", authorLabel: "Investigator agent",
        kind: "message", summary: text, body: text, visibility: "public", evidence: { table: "agent_runs", id: run.id },
      })
      await updateRun(run.id, { state: { ...state, followUp: { sentAt: now.toISOString(), askedAt: question.occurredAt.toISOString() } } as unknown as Record<string, unknown>, nextCheckAt: new Date(now.getTime() + FOLLOW_UP_WAIT_MINUTES * 60_000) })
      const summary = `No reply from the ${who} since ${asked}; sent one follow-up and will look again in ${FOLLOW_UP_WAIT_MINUTES} min.`
      await recordHit(file, now, "no reply", `The ${who} has not answered the agent's question from ${asked}.`, summary)
      hits.push({ rule: "no-reply", summary, orders: [file.order.reference] })
      options.log?.(`${file.order.reference}: ${summary}`)
      continue
    }
    // Still nothing after the follow-up: the run stops waiting and puts the question to a person.
    const since = `${asked} ${zoneShort(question.occurredAt, zone)}`
    const summary = `${Who} not answering since ${since}; the Investigator hands it to a person.`
    await recordHit(file, now, "no reply", `No answer to the question from ${since} or to the follow-up at ${clock(state.followUp.sentAt, zone)}.`, summary)
    hits.push({ rule: "no-reply", summary, orders: [file.order.reference], investigatorRunId: run.id })
    options.log?.(`${file.order.reference}: ${summary}`)
    if (!options.startAgents || !hasApiKey()) continue
    await updateRun(run.id, { state: { ...state, noReplySince: since } as unknown as Record<string, unknown> })
    const { resumeRun } = await import("./agents/investigator")
    const content = `No reply. The ${who} has not answered since ${since}: not your question, and not the follow-up sent at ${clock(state.followUp.sentAt, zone)} ${zoneShort(state.followUp.sentAt, zone)}. It is now ${clock(now, zone)} ${zoneShort(now, zone)}. Do not wait longer. Propose what a person should do now, and start the headline with "${Who} not answering since ${since}".`
    const resumed = resumeRun(run.id, pending.map((item) => ({ toolUseId: item.toolUseId, content })), { autoReply: false })
    if (options.wait) await resumed
    else void resumed.catch((error) => console.error("no-reply escalation", error))
  }
  return hits
}

/** Run every rule once against the current simulated time. */
export async function runMonitor(options: Options = {}): Promise<MonitorHit[]> {
  const now = await clockNow()
  // Ops took these orders over: no Monitor rule acts on them until a person hands them back (lib/takeover.ts).
  const taken = new Set((await openTakeovers()).map((row) => row.orderId))
  const files = (await getCases()).filter((file) => !taken.has(file.order.id))
  const on = (rule: NonNullable<Options["only"]>[number]) => !options.only || options.only.includes(rule)
  const hits = [...on("disruption") ? await disruptionRule(files, now, options) : [], ...on("gig-cancelled") ? await cancelledGigRule(files, now) : [], ...on("no-reply") ? await noReplyRule(now, options, taken) : []]
  // The disruption rule may have just started runs; the silent-car rule sees them as attended.
  return [...hits, ...on("silent-car") ? await silentCarRule((await getCases()).filter((file) => !taken.has(file.order.id)), now, options) : []]
}
