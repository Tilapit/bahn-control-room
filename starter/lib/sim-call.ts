// Simulated calls for the demo (fictional, clearly labelled): a scripted conversation a person can play from a to-do
// instead of a real phone. Pure data, so the browser can play it line by line. Only orders with a script get one.

export type CallLine = { who: "you" | "them"; text: string }
export type CallScript = { reference: string; contact: string; them: string; lines: CallLine[] }

const SCRIPTS: CallScript[] = [
  {
    // CD-420322: the Bentley stopped on a red warning light at Hollenmark services; the owner's service contact decides.
    reference: "CD-420322", contact: "Marvellin Motorhandel", them: "Service desk, Marvellin Motorhandel",
    lines: [
      { who: "you", text: "Hello, this is Bahn's control room, about your Bentley Continental GT on order CD-420322." },
      { who: "them", text: "Yes, we got your email. Where is the car now?" },
      { who: "you", text: "Parked at Hollenmark services on the A7 northbound, about 40 km south of Hannover. A red warning light came on; the driver stopped, is safe and is waiting with the car." },
      { who: "them", text: "Good. Please make sure nobody restarts it. Our recovery partner will collect it on a flatbed; they can be there by 15:30 today." },
      { who: "you", text: "Understood. The delivery in Hamburg was promised for today by 16:00." },
      { who: "them", text: "That will not happen today. Our workshop checks the car first; we will email a new delivery time before 17:00." },
      { who: "you", text: "Then I'll ask the driver to wait with the car and hand the keys to the recovery driver." },
      { who: "them", text: "Yes, keys to the recovery driver, please. Thank you for calling." },
    ],
  },
]

/** The scripted call for an order, or null when the demo has none. */
export function simulatedCall(reference: string): CallScript | null {
  return SCRIPTS.find((script) => script.reference === reference) ?? null
}
