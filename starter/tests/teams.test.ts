// Team views: every card belongs to exactly one desk and one market, decided by code from the records.
// The recorded cards (fixtures/agent-runs.json) and the dataset are read from files, so no database is needed.

import "./setup"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import type { StageKey } from "@/lib/case"
import { cardActions, DEFAULT_VIEW, deskOf, DESKS, inView, MARKETS, marketOf, passesThrough, routeTeam, type Team, viewLabel, viewWords } from "@/lib/teams"

const ROOT = join(process.cwd(), "..")
const jsonl = (name: string) => readFileSync(join(ROOT, "dataset", "data", `${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
type FixtureCard = { id: string; order_id: string; status: string; origin: string; severity: string; proposal: { action?: string } | null; options: { kind?: string; steps?: { action: string }[] }[]; group: { order_id: string }[] | null }

/** The order's lane stands in for its compiled stage here: the test is about the rules, not about compiling a case. */
const STAGE_OF_LANE: Record<string, StageKey> = { intake: "intake", ready: "ready", market: "finding_driver", booked: "driver_booked", moving: "moving", delivered: "delivered", cancelled: "cancelled" }

const base = (patch: Partial<Parameters<typeof deskOf>[0]>) => deskOf({ severity: "normal", action: null, steps: [], owners: [], signals: [], stage: null, ...patch })
const team = (market: Team["market"], countries: string[], desk: Team["desk"] = "Dispatch"): Team => ({ market, countries, crossBorder: countries.some((code) => marketOf(code) !== market), desk })

describe("team views", () => {
  it("every recorded card gets exactly one desk and one market", () => {
    const { tables } = JSON.parse(readFileSync(join(ROOT, "fixtures", "agent-runs.json"), "utf8")) as { tables: { cards: FixtureCard[] } }
    const orders = new Map(jsonl("orders").map((row) => [String(row.id), row]))
    const customers = new Map(jsonl("customers").map((row) => [String(row.id), row]))
    const addresses = new Map(jsonl("addresses").map((row) => [String(row.id), row]))
    const alerts = jsonl("alerts").filter((row) => row.status === "OPEN" || row.status === "ACKNOWLEDGED")
    const tasks = jsonl("work_items").filter((row) => row.status === "OPEN" || row.status === "NEEDS_EXTERNAL_INPUT")
    assert.ok(tables.cards.length >= 20, "the recording has cards")
    const desks = new Map<string, number>()
    for (const card of tables.cards) {
      const order = orders.get(card.order_id)
      assert.ok(order, `${card.id}: its order is in the dataset`)
      const { action, steps } = cardActions(card)
      const desk = deskOf({
        severity: card.severity, action, steps, stage: STAGE_OF_LANE[String(order.display_lane)] ?? null,
        owners: [...tasks, ...alerts].filter((row) => row.order_id === card.order_id && row.owner).map((row) => String(row.owner)),
        signals: alerts.filter((alert) => alert.order_id === card.order_id).map((alert) => String(alert.signal)),
      })
      const route = routeTeam(String(customers.get(String(order.customer_id))?.country ?? ""), [
        String(addresses.get(String(order.pickup_address_id))?.country ?? ""), String(addresses.get(String(order.delivery_address_id))?.country ?? ""),
      ])
      assert.equal(DESKS.filter((name) => name === desk).length, 1, `${card.id}: one desk, got ${desk}`)
      assert.equal(MARKETS.filter((name) => name === route.market).length, 1, `${card.id}: one market, got ${route.market}`)
      desks.set(desk, (desks.get(desk) ?? 0) + 1)
    }
    // The recorded morning spreads over the desks; no rule sends everything to one fallback.
    assert.ok(desks.size >= 4, `cards reach ${desks.size} desks: ${[...desks].map(([name, n]) => `${name} ${n}`).join(", ")}`)
  })

  it("the action decides the desk, then the steps, then the alert, then the stage", () => {
    assert.equal(base({ severity: "safety", action: "call_customer" }), "On the road", "a person's safety is the shift lead's first")
    assert.equal(base({ action: "book_ferry", steps: ["book_ferry", "book_hotel"] }), "Crossings & travel")
    assert.equal(base({ action: "cancel_driver_travel", steps: ["change_pickup_time", "cancel_driver_travel"] }), "Crossings & travel", "the card's own action wins over its steps")
    assert.equal(base({ action: "switch_driver" }), "Dispatch")
    assert.equal(base({ action: "message_driver", steps: ["change_ferry_booking", "message_driver"] }), "Crossings & travel", "a message names who is told; the step names the work")
    assert.equal(base({ action: "call_customer", steps: ["book_driver_travel", "change_pickup_time"] }), "Readiness", "the pickup time comes before the driver's train")
    assert.equal(base({ action: "call_contact", owners: ["ops-dispatch"], signals: ["EMPTY_PICKUP"], stage: "driver_booked" }), "Dispatch", "the desk the records gave the open work")
    assert.equal(base({ action: "message_driver", owners: ["Handover evidence"] }), "Handover", "owner titles work as well as ids")
    assert.equal(base({ action: "book_ferry", owners: ["ops-support"] }), "Crossings & travel", "the card's action wins over who owned the alert")
    assert.equal(base({ action: "message_customer", signals: ["INVOICE_REFERENCE_QUERY"], stage: "delivered" }), "Support")
    assert.equal(base({ action: "note", signals: ["CONDITION_CLAIM_REVIEW"], stage: "delivered" }), "Handover")
    assert.equal(base({ action: "message_driver", signals: ["EMPTY_PICKUP"] }), "Readiness")
    assert.equal(base({ action: "call_customer", stage: "moving" }), "Support", "talking to the customer is the work when nothing else names a desk")
    assert.equal(base({ action: "note", stage: "moving" }), "On the road")
    assert.equal(base({ action: "answer", stage: "finding_driver" }), "Dispatch")
    assert.equal(base({ action: null, stage: null }), "Support", "a card with nothing to go on still has one desk")
  })

  it("market is the customer's country; a route into another country is cross-border", () => {
    assert.equal(marketOf("FI"), "Finland")
    assert.equal(marketOf("dk"), "Denmark")
    assert.equal(marketOf("FR"), "Other")
    assert.equal(marketOf(null), "Other")
    assert.deepEqual(routeTeam("FI", ["DE", "DE", "FI"]), { market: "Finland", countries: ["DE", "FI"], crossBorder: true })
    assert.equal(routeTeam("FI", ["FI", "FI"]).crossBorder, false)
    assert.equal(routeTeam("FR", ["FR", "FR"]).crossBorder, false)
  })

  it("a view keeps its market, adds orders passing through when asked, and keeps only the ticked desks", () => {
    const finnishFromGermany = team("Finland", ["DE", "FI"])
    const german = team("Germany", ["DE"])
    const quiet = team("Finland", ["FI"], null)
    assert.ok(inView(finnishFromGermany, DEFAULT_VIEW) && inView(german, DEFAULT_VIEW) && inView(quiet, DEFAULT_VIEW), "everyone, every desk: all of it")
    const germany = { market: "Germany" as const, desks: [], passingThrough: false }
    assert.ok(inView(german, germany))
    assert.ok(!inView(finnishFromGermany, germany), "another market, without passing through")
    assert.ok(inView(finnishFromGermany, { ...germany, passingThrough: true }), "passing through Germany")
    assert.ok(passesThrough(finnishFromGermany, { ...germany, passingThrough: true }))
    assert.ok(!passesThrough(german, { ...germany, passingThrough: true }), "its own market is not passing through")
    assert.ok(!inView(team("Finland", ["FI"]), { ...germany, passingThrough: true }), "a domestic Finnish order never passes through Germany")
    const dispatch = { market: "Everyone" as const, desks: ["Dispatch" as const], passingThrough: false }
    assert.ok(inView(german, dispatch))
    assert.ok(!inView(team("Germany", ["DE"], "Handover"), dispatch), "another desk")
    assert.ok(!inView(quiet, dispatch), "nothing open: at no desk")
  })

  it("names the view in a few words", () => {
    assert.equal(viewLabel(DEFAULT_VIEW), "Everyone · All desks")
    assert.equal(viewLabel({ market: "Finland", desks: [], passingThrough: false }), "Finland · All desks")
    assert.equal(viewLabel({ market: "Finland", desks: ["Dispatch"], passingThrough: false }), "Finland · Dispatch")
    assert.equal(viewLabel({ market: "Germany", desks: ["Dispatch", "Handover"], passingThrough: true }), "Germany · 2 desks")
    assert.equal(viewWords({ market: "Finland", desks: [], passingThrough: false }), "in Finland")
    assert.equal(viewWords(DEFAULT_VIEW), "")
  })
})
