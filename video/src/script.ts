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
    vo: "This is Bahn Control Room.",
    captions: [],
    parts: [{ at: "", part: { kind: "title" } }],
  },
  {
    label: "1 · The problem",
    vo: "On the starter board, forty-three of a hundred orders were flagged. Here, five need you now, sorted by when something is lost. We scaled your hundred orders to a thousand with synthetic copies; the list stays this small. Everyone sees who owns what: this one, claimed forty-one minutes ago with no activity, is free.",
    captions: [
      { text: "Starter board: 43 of 100 flagged", at: "On the starter board" },
      { text: "Now: 5 need you", at: "Here, five need you" },
      { text: "Everyone sees who owns what", at: "Everyone sees" },
    ],
    parts: [
      { at: "", part: { kind: "slide", lines: ["Every hour something changes.", "Each exception starts a chain.", "Today, a person holds the chain in their head."] } },
      { at: "Here, five need you", part: { kind: "shot", img: "foryou", highlights: [{ box: "title", at: "Here, five need you" }, { box: "tabs", at: "Everyone sees" }] } },
      { at: "this one, claimed", part: { kind: "shot", img: "foryou-mikko", highlights: [{ box: "mikko", at: "this one, claimed" }] } },
    ],
  },
  {
    label: "2 · How the agents run",
    vo: "Haiku classifies every message. Code handles urgency, routing and rules, at no cost. The Investigator asks drivers and sites and looks up ferries, trains, repair shops. It runs on Sonnet; Opus only for safety, costs over five hundred euros, or conflicting evidence. A Verifier checks every fact. The Monitor watches GPS, bookings and disruption feeds. A routine Sonnet investigation costs about two cents; this Opus safety case, twenty-eight.",
    captions: [
      { text: "Code first, models only where needed", at: "Code handles" },
      { text: "Opus only for safety, cost, conflicts", at: "It runs on Sonnet" },
      { text: "2 cents on Sonnet, 28 on Opus", at: "A routine Sonnet" },
    ],
    parts: [
      { at: "", part: { kind: "diagram" } },
      { at: "The Monitor watches", part: { kind: "shot", img: "agents", highlights: [{ box: "summary", at: "The Monitor watches" }] } },
      { at: "A routine Sonnet", part: { kind: "shot", img: "agents-quiet", highlights: [{ box: "tiles", at: "A routine Sonnet" }, { box: "cost", at: "this Opus safety case" }] } },
    ],
  },
  {
    label: "3 · One case, end to end",
    vo: "A driver stops on the A7: red warning light. The agent asks if they're safe, where, and for a photo. It checks the owner, the delivery promise and nearby recovery. The Verifier sent its draft back twice, one error each time; it fixed both. One decision reaches a person: call the dealer. Every fact shows source and time; quotes are labelled as quotes. Agents never contact customers; that's enforced in code, not in a prompt. When I approve, the call stays on my to-do until I log the outcome. Your ops team said: if it disappears, I'll forget.",
    captions: [
      { text: "Driver: red warning light", at: "A driver stops" },
      { text: "Agent: safe? where? photo?", at: "The agent asks" },
      { text: "Checker found two errors", at: "The Verifier sent" },
      { text: "Every fact: source and time", at: "Every fact shows" },
      { text: "A quote is never a booking", at: "quotes are labelled" },
      { text: "Approve, and it stays on your to-do", at: "When I approve" },
    ],
    parts: [
      { at: "", part: { kind: "shot", img: "trace", highlights: [{ box: "model", at: "A driver stops" }, { box: "question", at: "The agent asks" }, { box: "reply", at: "It checks the owner" }] } },
      { at: "The Verifier sent", part: { kind: "shot", img: "trace2", highlights: [{ box: "sentBack", at: "The Verifier sent" }, { box: "sentBack2", at: "one error each time" }] } },
      { at: "Every fact shows", part: { kind: "shot", img: "case-facts", highlights: [{ box: "chips", at: "Every fact shows" }, { box: "quotes", at: "quotes are labelled" }, { box: "checked", at: "Agents never contact" }] } },
      { at: "When I approve", part: { kind: "shot", img: "case-approve", highlights: [{ box: "checklist", at: "When I approve" }, { box: "ifApprove", at: "the call stays" }, { box: "approve", at: "Your ops team said" }] } },
    ],
  },
  {
    label: "4 · Control and trust",
    vo: "You set what agents may do alone. Reading, asking and looking up need no approval; bookings, costs and date changes ask first. Contacting a customer always asks you. Every decision is recorded with a reason. When an action is often approved unchanged, the app suggests autonomy.",
    captions: [
      { text: "Rules live in code", at: "You set what" },
      { text: "Every decision teaches the agents", at: "Every decision" },
      { text: "Autonomy grows when it's earned", at: "When an action" },
    ],
    parts: [
      { at: "", part: { kind: "shot", img: "permissions", highlights: [{ box: "ownSection", at: "Reading, asking" }, { box: "customer", at: "Contacting a customer" }] } },
      { at: "Every decision", part: { kind: "shot", img: "learning", highlights: [{ box: "playbook", at: "Every decision" }, { box: "rates", at: "When an action" }] } },
    ],
  },
  {
    label: "5 · One context",
    vo: "Everything an order touches lands on one timeline: driver chat, Intercom, Slack, email, calls, GPS and bookings. In production, each source is one adapter: an Intercom webhook, Slack events, GPS feed, call transcripts, booking APIs.",
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
    vo: "Your dataset: orders, messages, GPS, bookings and alerts. Real: the agents' work, recorded Claude runs replayable without an API key. Simulated: driver and site replies, repair shops, ferry and train options, disruption notices, two colleagues, nine hundred extra orders.",
    captions: [],
    parts: [{ at: "", part: { kind: "demo" } }],
  },
  {
    label: "7 · How we built it",
    vo: "Built with Claude Code from a written spec, checked phase by phase. Claude Code found nine errors in our spec; we checked each against your data. We threw away letting a model sort the queue; urgency is code now. Two reviewers judged it blind from screenshots; your ops team shaped the to-do list and ownership. When an eval failed, we kept the test and fixed the code. Agents do the legwork. People make the judgement calls.",
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
