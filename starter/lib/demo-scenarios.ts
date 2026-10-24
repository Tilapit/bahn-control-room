// Demo only: the scripted events behind the demo page's buttons (SPEC 8.6, 9).
// Every event is fictional and goes through the same ingest path as a real
// message: stored, classified, routed. A scenario first forgets earlier live work
// on its order, so it can be played again from the same start. The clock is left
// where it is: moving it back would put the morning's agent work in the future.

import { getCase } from "./case"
import { resetOrderLiveState } from "./agents/reset"
import { startInvestigation } from "./agents/investigator"
import { hasApiKey } from "./agents/llm"
import { readRecording, startReplay } from "./recording"
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

export type PlayMode = "live" | "replay"

/**
 * Play a scripted event. Live: real agents, in the background. Replay: the rows a live run of the same
 * scenario wrote, played back at the speed they were written (fixtures/recordings), marked as a replay.
 */
export async function playDemoEvent(id: string, mode: PlayMode = "live"): Promise<{ orderId: string; entryId?: string; runId?: string; mode: PlayMode }> {
  const event = DEMO_EVENTS.find((candidate) => candidate.id === id)
  if (!event) throw new Error(`No demo event ${id}`)
  const file = await getCase(event.order)
  if (!file) throw new Error(`No order ${event.order}`)
  if (mode === "replay") {
    const recording = await readRecording(id)
    if (!recording) throw new Error("There is no recording of this event yet. Play it live once with npm run scenario:record.")
    await resetOrderLiveState(file.order.id)
    await startReplay(recording)
    return { orderId: file.order.id, mode }
  }
  if (!hasApiKey()) throw new Error("Live agents need an API key. Without one, use Replay: it plays a recorded live run at its real speed.")
  const autoReply = await autoReplyEnabled()

  if (id === "scenario-1") {
    await resetOrderLiveState(file.order.id)
    const fresh = (await getCase(event.order))!
    void startInvestigation(event.order, { trigger: `Open signals on this order: ${liveSignals(fresh).join("; ")}.`, autoReply }).catch((error) => console.error("scenario 1", error))
    return { orderId: file.order.id, mode }
  }
  if (id === "scenario-2") {
    await resetOrderLiveState(file.order.id)
    const stored = await ingest({
      order: event.order, source: "driver_chat", channel: "driver_chat", authorType: "driver", authorLabel: "Kasper Kovelund",
      body: "The red warning came back when I started the engine to move the car away from the entrance. Now it also beeps. I switched it off again. Is someone coming?",
      demoKind: "red warning light",
    })
    void processEntry(stored.entryId).catch((error) => console.error("scenario 2", error))
    return { orderId: file.order.id, entryId: stored.entryId, mode }
  }
  if (id === "slack-note") {
    const stored = await ingest({
      order: event.order, source: "slack", channel: "internal_note", authorType: "operator", authorLabel: "Driver travel", visibility: "internal",
      body: "Ferry line desk says they can hold one vehicle space on Thursday's 16:00 sailing until 13:30 today if we confirm. Not booked.",
      demoKind: "slack note",
    })
    void processEntry(stored.entryId).catch((error) => console.error("slack note", error))
    return { orderId: file.order.id, entryId: stored.entryId, mode }
  }
  const stored = await ingest({
    order: event.order, source: "email", channel: "customer_email", authorType: "customer", authorLabel: "Kavellora Car House",
    body: "Thank you for the update. If the car cannot arrive on Tuesday, Wednesday 28 October also works for us, but please tell us before you change anything.",
    demoKind: "customer email",
  })
  void processEntry(stored.entryId).catch((error) => console.error("customer email", error))
  return { orderId: file.order.id, entryId: stored.entryId, mode }
}
