// The Router (SPEC 7) is code: where a classified message goes. And which model the Investigator starts on.

import "./setup"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { initialModel } from "@/lib/agents/investigator"
import { MODELS } from "@/lib/models"
import { routeFor } from "@/lib/router"

const quiet = { orderSafety: false, waitingRun: false }

describe("routing", () => {
  it("a driver's message goes to the run that is waiting for that driver, before anything else", () => {
    assert.equal(routeFor({ authorType: "driver", classification: { urgency: "safety", needs: "investigator" }, orderSafety: true, waitingRun: true }), "resumed")
  })

  it("a site's message answers a run waiting on the site; a customer's message never resumes a run", () => {
    assert.equal(routeFor({ authorType: "site_contact", classification: null, orderSafety: false, waitingRun: true }), "resumed")
    assert.equal(routeFor({ authorType: "customer", classification: null, orderSafety: false, waitingRun: true }), "nothing")
  })

  it("safety goes to the Investigator, whoever classified it", () => {
    assert.equal(routeFor({ ...quiet, authorType: "driver", classification: { urgency: "safety", needs: "nothing" } }), "investigator")
    assert.equal(routeFor({ ...quiet, authorType: "customer", classification: { urgency: "safety", needs: "nothing" } }), "investigator")
  })

  it("any word from the driver on an order with a safety signal goes to the Investigator, even if the Classifier missed it", () => {
    assert.equal(routeFor({ authorType: "driver", classification: { urgency: "normal", needs: "driver_support" }, orderSafety: true, waitingRun: false }), "investigator")
    assert.equal(routeFor({ authorType: "driver", classification: null, orderSafety: true, waitingRun: false }), "investigator")
  })

  it("a change or a risk the Classifier marks goes to the Investigator", () => {
    assert.equal(routeFor({ ...quiet, authorType: "customer", classification: { urgency: "time", needs: "investigator" } }), "investigator")
  })

  it("a driver's routine question goes to Driver support; the same words from a customer do not", () => {
    assert.equal(routeFor({ ...quiet, authorType: "driver", classification: { urgency: "normal", needs: "driver_support" } }), "driver_support")
    assert.equal(routeFor({ ...quiet, authorType: "customer", classification: { urgency: "normal", needs: "driver_support" } }), "nothing")
  })

  it("everything else starts nothing: the facts stay on file", () => {
    assert.equal(routeFor({ ...quiet, authorType: "operator", classification: { urgency: "normal", needs: "nothing" } }), "nothing")
    assert.equal(routeFor({ ...quiet, authorType: "driver", classification: null }), "nothing")
  })
})

describe("which model investigates", () => {
  it("Opus from the start when a person's safety may be involved, Sonnet otherwise", () => {
    assert.equal(initialModel(true), MODELS.opus)
    assert.equal(initialModel(false), MODELS.sonnet)
  })
})
