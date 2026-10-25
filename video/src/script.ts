// The video, scene by scene: narration, captions and what is on screen.
// Times are anchored to words in the narration ("at"): a phrase is found in the text and its
// position gives the moment, so captions and highlights follow the voice.

export type Part =
  | { kind: "title" }
  | { kind: "slide"; lines: string[] }
  | { kind: "diagram" }
  | { kind: "shot"; img: string; highlights: { box: string; at: string }[] }
  | { kind: "demo" }
  | { kind: "built"; lines: { text: string; at: string }[] }
  | { kind: "end" }

export type Scene = {
  label: string
  vo: string
  captions: { text: string; at: string }[]
  parts: { at: string; part: Part }[]
}

export const scenes: Scene[] = [
  {
    label: "",
    vo: "This is our control room for Bahn. Agents do the legwork. People make the judgement calls.",
    captions: [],
    parts: [{ at: "", part: { kind: "title" } }],
  },
  {
    label: "1 · The problem",
    vo: "Your ops team works by phone, chat and email, and every exception starts a chain someone has to hold in their head. On the starter board, forty-three of a hundred orders were flagged 'needs a person'. Here, five need you now, sorted by when something is lost. We scaled your hundred orders to a thousand with synthetic copies, to prove the list stays this small. And everyone can see who owns each case; this one was claimed forty-one minutes ago with no activity, so it's free to pick up.",
    captions: [
      { text: "Starter board: 43 of 100 flagged", at: "On the starter board" },
      { text: "Now: 5 need you", at: "Here, five need you" },
      { text: "Everyone sees who owns what", at: "And everyone can see" },
    ],
    parts: [
      { at: "", part: { kind: "slide", lines: ["Every hour something changes.", "Each exception starts a chain.", "Today, a person holds the chain in their head."] } },
      { at: "On the starter board", part: { kind: "shot", img: "foryou", highlights: [{ box: "title", at: "Here, five need you" }, { box: "tabs", at: "And everyone can see" }] } },
      { at: "this one was claimed", part: { kind: "shot", img: "foryou-mikko", highlights: [{ box: "mikko", at: "this one was claimed" }] } },
    ],
  },
  {
    label: "2 · How the agents run",
    vo: "Here's how it runs. Every message, from driver chat, support, internal notes or email, is read by the Classifier, a small fast model. Code then does what code should: deadlines, urgency, routing and the rules, at no cost. Real problems go to the Investigator. It works in a loop with tools: it asks the driver or the site, looks up ferries, trains and repair shops, and reads the order's history. It starts on Sonnet and moves to Opus only for safety cases, costs over five hundred euros, or evidence that disagrees. A Verifier checks every fact against its source before you see anything. The Monitor watches GPS, bookings and disruption feeds, so a rail strike is caught before the driver writes. A routine investigation on Sonnet costs about two cents; this safety case on Opus cost twenty-eight.",
    captions: [
      { text: "Code first, models only where needed", at: "Code then does" },
      { text: "Opus only for safety, cost, conflicts", at: "It starts on Sonnet" },
      { text: "2 cents on Sonnet, 28 on Opus", at: "A routine investigation" },
    ],
    parts: [
      { at: "", part: { kind: "diagram" } },
      { at: "The Monitor watches", part: { kind: "shot", img: "agents", highlights: [{ box: "summary", at: "The Monitor watches" }] } },
      { at: "A routine investigation", part: { kind: "shot", img: "agents-quiet", highlights: [{ box: "tiles", at: "A routine investigation" }, { box: "cost", at: "this safety case" }] } },
    ],
  },
  {
    label: "3 · One case, end to end",
    vo: "One real case. A driver stops on the A7 with a red warning light. Before anyone at Bahn sees it, the agent asks if they're safe, exactly where, and for a photo. It checks the car's owner, today's delivery promise in Hamburg, and recovery services nearby. The Verifier sent its draft back twice, one error each time; it fixed both. Then one decision reaches a person: call the dealer for their recovery choice. Every fact shows where it came from and when, and a quote is labelled as a quote. Agents never contact a customer themselves; that is enforced in code, not in a prompt. When I approve, the call stays on my to-do list until I log what happened. Your ops team told us: if it disappears, I'll forget.",
    captions: [
      { text: "Driver: red warning light", at: "A driver stops" },
      { text: "Agent: safe? where? photo?", at: "the agent asks" },
      { text: "Checker found two errors", at: "The Verifier sent" },
      { text: "Every fact: source and time", at: "Every fact shows" },
      { text: "A quote is never a booking", at: "a quote is labelled" },
      { text: "Approve, and it stays on your to-do", at: "When I approve" },
    ],
    parts: [
      { at: "", part: { kind: "shot", img: "trace", highlights: [{ box: "model", at: "A driver stops" }, { box: "question", at: "the agent asks" }, { box: "reply", at: "It checks the car's" }] } },
      { at: "The Verifier sent", part: { kind: "shot", img: "trace2", highlights: [{ box: "sentBack", at: "The Verifier sent" }, { box: "sentBack2", at: "one error each time" }] } },
      { at: "Every fact shows", part: { kind: "shot", img: "case-facts", highlights: [{ box: "chips", at: "Every fact shows" }, { box: "quotes", at: "a quote is labelled" }, { box: "checked", at: "Agents never contact" }] } },
      { at: "When I approve", part: { kind: "shot", img: "case-approve", highlights: [{ box: "checklist", at: "When I approve" }, { box: "ifApprove", at: "the call stays" }, { box: "approve", at: "Your ops team told us" }] } },
    ],
  },
  {
    label: "4 · Control and trust",
    vo: "You set what agents may do alone. Reading, asking drivers and looking things up need no approval. Bookings, costs and date changes ask you first. Contacting a customer always asks you. Every approval, rejection and correction is recorded with a reason, and agents look at similar past decisions before they propose. When a type of action is approved unchanged often enough, the app suggests letting the agent do it alone.",
    captions: [
      { text: "Rules live in code", at: "You set what" },
      { text: "Every decision teaches the agents", at: "Every approval" },
      { text: "Autonomy grows when it's earned", at: "When a type of action" },
    ],
    parts: [
      { at: "", part: { kind: "shot", img: "permissions", highlights: [{ box: "ownSection", at: "Reading, asking" }, { box: "customer", at: "Contacting a customer" }] } },
      { at: "Every approval", part: { kind: "shot", img: "learning", highlights: [{ box: "playbook", at: "Every approval" }, { box: "rates", at: "When a type of action" }] } },
    ],
  },
  {
    label: "5 · One context",
    vo: "Everything an order touches lands on one timeline: driver chat, Intercom, Slack, email, calls, GPS and bookings. Nothing agreed in one channel is lost to the next shift. In production, each source is one adapter: an Intercom webhook, Slack events, your GPS feed, call transcripts, booking APIs.",
    captions: [
      { text: "One timeline per order", at: "Everything an order" },
      { text: "In production: one adapter per source", at: "In production" },
    ],
    parts: [
      { at: "", part: { kind: "shot", img: "sources", highlights: [{ box: "info", at: "Everything an order" }, { box: "people", at: "driver chat, Intercom" }, { box: "cars", at: "GPS and bookings" }] } },
      { at: "an Intercom webhook", part: { kind: "shot", img: "orders", highlights: [{ box: "whoColumn", at: "an Intercom webhook" }] } },
    ],
  },
  {
    label: "6 · What's real, what's demo",
    vo: "To be clear about the demo. The orders, messages, GPS, bookings and alerts are your dataset. The agents' work is real: recorded runs of Claude models on that data, which anyone can replay without an API key, or run live with one. What's simulated is the outside world: driver and site replies, repair shops, ferry and train options, disruption notices, two colleagues, and nine hundred extra orders to test scale.",
    captions: [],
    parts: [{ at: "", part: { kind: "demo" } }],
  },
  {
    label: "7 · How we built it",
    vo: "We built this with Claude Code from a written spec, phase by phase, checking each step. Claude Code found nine errors in our own spec, and we checked every one against your data before accepting it. We threw away our first idea of letting a model sort the queue; urgency is plain code now. Two reviewers who had never seen the code judged it from screenshots, and your ops team shaped the to-do list and ownership. When an eval failed, we kept the test and fixed the code. Agents do the legwork. People make the judgement calls.",
    captions: [],
    parts: [
      {
        at: "",
        part: {
          kind: "built",
          lines: [
            { text: "Written spec first, built phase by phase with Claude Code, each phase checked", at: "" },
            { text: "Claude Code found 9 errors in our spec — we verified each against your data", at: "Claude Code found" },
            { text: "Threw away: an LLM sorting the queue. Urgency is code now", at: "We threw away" },
            { text: "Two blind UX reviews, and a session with your ops team", at: "Two reviewers" },
            { text: "A failing eval was kept, and the code fixed — 73 tests, 11 eval groups", at: "When an eval failed" },
          ],
        },
      },
      { at: "Agents do the legwork", part: { kind: "end" } },
    ],
  },
]
