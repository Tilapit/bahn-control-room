// Demo only: the scripted events behind the demo page's buttons (SPEC 8.6, 9).
// Every event is fictional and goes through the same ingest path as a real
// message: stored, classified, routed. A scenario first forgets earlier live work
// on its order, so it can be played again from the same start.

import { getCase } from "./case"
import { resetClock } from "./clock"
import { resetOrderLiveState } from "./agents/reset"
import { startInvestigation } from "./agents/investigator"
import { autoReplyEnabled } from "./demo"
import { ingest, processEntry } from "./ingest"
import { liveSignals } from "./signals"

export type DemoEvent = { id: string; label: string; detail: string; order: string }

export const DEMO_EVENTS: DemoEvent[] = [
  { id: "scenario-1", order: "CD-420299", label: "Scenario 1: ferry sold out", detail: "Resets CD-420299, then the Investigator looks at the sold-out ferry and the timed-out booking attempt." },
  { id: "scenario-2", order: "CD-420322", label: "Scenario 2: red warning light", detail: "Resets CD-420322, then the driver writes that the red warning came back. Classifier, Router, Investigator on Opus." },
  { id: "slack-note", order: "CD-420603", label: "Slack note: ferry line can hold a space", detail: "Driver travel posts an internal note on CD-420603." },
  { id: "customer-email", order: "CD-420299", label: "Customer email: Wednesday is fine", detail: "Kavellora Car House writes about the delivery day on CD-420299." },
]

export async function playDemoEvent(id: string): Promise<{ orderId: string; entryId?: string; runId?: string }> {
  const event = DEMO_EVENTS.find((candidate) => candidate.id === id)
  if (!event) throw new Error(`No demo event ${id}`)
  const file = await getCase(event.order)
  if (!file) throw new Error(`No order ${event.order}`)
  const autoReply = await autoReplyEnabled()

  if (id === "scenario-1") {
    await resetOrderLiveState(file.order.id)
    await resetClock()
    const fresh = (await getCase(event.order))!
    void startInvestigation(event.order, { trigger: `Open signals on this order: ${liveSignals(fresh).join("; ")}.`, autoReply }).catch((error) => console.error("scenario 1", error))
    return { orderId: file.order.id }
  }
  if (id === "scenario-2") {
    await resetOrderLiveState(file.order.id)
    await resetClock()
    const stored = await ingest({
      order: event.order, source: "driver_chat", channel: "driver_chat", authorType: "driver", authorLabel: "Kasper Kovelund",
      body: "The red warning came back when I started the engine to move the car away from the entrance. Now it also beeps. I switched it off again. Is someone coming?",
      demoKind: "red warning light",
    })
    void processEntry(stored.entryId).catch((error) => console.error("scenario 2", error))
    return { orderId: file.order.id, entryId: stored.entryId }
  }
  if (id === "slack-note") {
    const stored = await ingest({
      order: event.order, source: "slack", channel: "internal_note", authorType: "operator", authorLabel: "Driver travel", visibility: "internal",
      body: "Ferry line desk says they can hold one vehicle space on Thursday's 16:00 sailing until 13:30 today if we confirm. Not booked.",
      demoKind: "slack note",
    })
    void processEntry(stored.entryId).catch((error) => console.error("slack note", error))
    return { orderId: file.order.id, entryId: stored.entryId }
  }
  const stored = await ingest({
    order: event.order, source: "email", channel: "customer_email", authorType: "customer", authorLabel: "Kavellora Car House",
    body: "Thank you for the update. If the car cannot arrive on Tuesday, Wednesday 28 October also works for us, but please tell us before you change anything.",
    demoKind: "customer email",
  })
  void processEntry(stored.entryId).catch((error) => console.error("customer email", error))
  return { orderId: file.order.id, entryId: stored.entryId }
}
