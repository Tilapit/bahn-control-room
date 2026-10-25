import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { eq, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { recordedMorning } from "@/lib/how-it-works"
import { modelName, ROLE_MODEL } from "@/lib/models"
import { orders } from "@/lib/schema"
import { permissions } from "@/lib/settings"
import { at } from "@/lib/time"
import { SettingsNav } from "../settings-nav"

export const metadata: Metadata = { title: "How it works" }

const DESK_ZONE = "Europe/Helsinki"
const usd = (value: number) => value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(value >= 0.1 ? 2 : 3)}`

// ---------------------------------------------------------------------------
// The flow, as one picture
// ---------------------------------------------------------------------------

type Node = { title: string; sub: string; kind: "signal" | "model" | "code" | "screen" | "person" }
const FLOW: Node[] = [
  { title: "Message or signal", sub: "chat, email, GPS, alert", kind: "signal" },
  { title: "Classifier", sub: modelName(ROLE_MODEL.classifier), kind: "model" },
  { title: "Urgency, routing", sub: "Code", kind: "code" },
  { title: "Investigator", sub: `${modelName(ROLE_MODEL.investigator)} or ${modelName(ROLE_MODEL.investigatorSenior)}`, kind: "model" },
  { title: "Verifier", sub: modelName(ROLE_MODEL.verifier), kind: "model" },
  { title: "For you", sub: "only what needs you", kind: "screen" },
  { title: "You decide", sub: "approve, reject, reply", kind: "person" },
  { title: "Executor", sub: "Code, after 8 s", kind: "code" },
]
const W = 124
const STEP = 140
const x = (index: number) => 8 + index * STEP
const mid = (index: number) => x(index) + W / 2

/** Words in lines of at most `max` characters, so a subtitle stays inside its box. */
function wrap(text: string, max: number): string[] {
  const lines: string[] = []
  for (const word of text.split(" ")) {
    const last = lines[lines.length - 1]
    if (last && `${last} ${word}`.length <= max) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  return lines
}

function Box({ at: left, top, width = W, height = 64, title, sub, kind }: { at: number; top: number; width?: number; height?: number } & Node) {
  const lines = wrap(sub, 17)
  const first = top + height / 2 - (lines.length * 13) / 2 + 2
  return <g className={`dg-node ${kind}`}>
    <rect x={left} y={top} width={width} height={height} rx={9} />
    <text className="dg-title" x={left + width / 2} y={first} textAnchor="middle">{title}</text>
    {lines.map((line, index) => <text key={index} className="dg-sub" x={left + width / 2} y={first + 16 + index * 13} textAnchor="middle">{line}</text>)}
  </g>
}

function Flow() {
  const row = 46
  const below = 168
  return <svg className="dg" viewBox="0 0 1120 228" role="img" aria-labelledby="dg-title dg-desc">
    <title id="dg-title">How a message becomes a decision</title>
    <desc id="dg-desc">A message or signal goes to the Classifier, then code works out urgency and routing, the Investigator looks into it, the Verifier checks the card, it appears in For you, a person decides, and the Executor carries it out. The Monitor starts the same path when something goes quiet; Driver support answers routine driver questions; the Investigator asks the driver or site and can close a case without a card; a person's reply goes back to the Investigator.</desc>
    <defs>
      <marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path className="dg-head" d="M0,0 L10,5 L0,10 z" /></marker>
    </defs>
    {/* The main path. */}
    {FLOW.slice(0, -1).map((_, index) => <line key={index} className="dg-line" x1={x(index) + W + 2} y1={row + 32} x2={x(index + 1) - 3} y2={row + 32} markerEnd="url(#dg-arrow)" />)}
    {FLOW.map((node, index) => <Box key={node.title} at={x(index)} top={row} {...node} />)}
    {/* A person's reply goes back to the Investigator. */}
    <path className="dg-line" d={`M ${mid(6)} ${row - 2} V 18 H ${mid(3)} V ${row - 4}`} markerEnd="url(#dg-arrow)" />
    <text className="dg-note" x={(mid(3) + mid(6)) / 2} y={13} textAnchor="middle">your one-sentence reply: the agent continues</text>
    {/* Around the path. */}
    <Box at={x(0)} top={below} height={50} title="Monitor" sub="Code: silence, notices" kind="code" />
    <line className="dg-line" x1={mid(0)} y1={below - 2} x2={mid(0)} y2={row + 67} markerEnd="url(#dg-arrow)" />
    <Box at={x(2)} top={below} height={50} title="Driver support" sub={`${modelName(ROLE_MODEL.driverSupport)}: routine questions`} kind="model" />
    <line className="dg-line" x1={mid(2)} y1={row + 66} x2={mid(2)} y2={below - 3} markerEnd="url(#dg-arrow)" />
    <Box at={x(3)} top={below} height={50} title="Driver or site" sub="asked, no approval" kind="signal" />
    <line className="dg-line" x1={mid(3) - 14} y1={row + 66} x2={mid(3) - 14} y2={below - 3} markerEnd="url(#dg-arrow)" />
    <line className="dg-line" x1={mid(3) + 14} y1={below - 2} x2={mid(3) + 14} y2={row + 67} markerEnd="url(#dg-arrow)" />
    <Box at={x(4)} top={below} height={50} title="Closed, no card" sub="the records explain it" kind="signal" />
    <path className="dg-line" d={`M ${x(3) + W - 10} ${row + 66} V ${row + 92} H ${mid(4)} V ${below - 3}`} markerEnd="url(#dg-arrow)" />
    <Box at={x(7)} top={below} height={50} title="Order timeline" sub="what was done, by whom" kind="signal" />
    <line className="dg-line" x1={mid(7)} y1={row + 66} x2={mid(7)} y2={below - 3} markerEnd="url(#dg-arrow)" />
  </svg>
}

const STEPS: { title: string; who: string; text: string }[] = [
  { title: "Message or signal", who: "", text: "A driver writes, a customer emails, a site calls, an alert fires, GPS stops moving, or a strike or road closure is announced. Everything lands on the order's one timeline." },
  { title: "Classifier", who: modelName(ROLE_MODEL.classifier), text: "Reads every message once: which order, what it is about, whether it changes a fact. It files what was said as “stated, not confirmed”, never as a confirmed fact." },
  { title: "Urgency and routing", who: "Code", text: "Works out what is lost next and when (a ferry check-in, a pickup slot, a delivery promise) and who should look: nobody, Driver support, or the Investigator. Rules and arithmetic, the same every time." },
  { title: "Investigator", who: `${modelName(ROLE_MODEL.investigator)}; ${modelName(ROLE_MODEL.investigatorSenior)} for safety, costs over €500 or records that disagree`, text: "Does the cheap work first: reads the order, asks the driver or the site, looks up ferries, trains, hotels and repair shops. If the records explain it, it closes the case without bothering anyone. Otherwise it writes a card." },
  { title: "Verifier", who: modelName(ROLE_MODEL.verifier), text: "Checks every fact on the card against the record it cites before you see it. A quote called a booking, or a driver's words stated as a position, sends the card back." },
  { title: "For you", who: "", text: "Only the cards that need a person, the one where something is lost first at the top. Each says what happened, what we know with sources, what the agent proposes and what it costs." },
  { title: "You decide", who: "A person", text: "Approve, reject, or write one sentence back to the agent, which continues by itself. You have 8 seconds to undo." },
  { title: "Executor", who: "Code", text: "Does exactly what you approved, after checking the situation again (no second ferry booking, the sailing still has space), and writes what it did on the order's timeline." },
]

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

type Source = { what: string; key: string[]; today: string; production: string }
const SOURCES: Source[] = [
  { what: "Driver messages", key: ["driver_chat"], today: "Recorded driver chats (app chat and WhatsApp), and the driver phone on the Demo page", production: "The driver app's chat and WhatsApp, through their message feeds" },
  { what: "Support conversations", key: ["support"], today: "Recorded support chats with customers, drivers and sites", production: "Intercom, which sends each new message as it arrives" },
  { what: "Internal notes and alerts", key: ["slack", "alert"], today: "Recorded internal notes, alert posts and replies", production: "Slack, from the operations channels, and the alerting system" },
  { what: "Customer email", key: ["email"], today: "Recorded customer emails", production: "The shared support mailbox" },
  { what: "Phone calls", key: ["call"], today: "Recorded call notes with sites", production: "The phone system's call log and notes" },
  { what: "GPS", key: ["gps"], today: "Recorded driver-app positions: km to go and an ETA, no map coordinates", production: "The GPS feed from the driver app" },
  { what: "Orders, plans, drivers and gigs", key: ["order", "system"], today: "A snapshot of 100 fictional orders, taken Wed 21 Oct at 12:00 Helsinki time (scale mode adds 900 made-up copies)", production: "Bahn's operations platform" },
  { what: "Ferries, trains, hotels, repair shops", key: ["booking", "quote"], today: "Recorded bookings and quotes; new look-ups are answered by a simulator built from them", production: "Booking systems of the ferry lines, rail operators and hotels, and a repair network" },
  { what: "Strikes, protests, road closures", key: [], today: "Three fictional notices", production: "Traffic and rail operator notices" },
]

export default async function HowItWorks() {
  await connection()
  const [{ rows }, counts] = await Promise.all([
    permissions(),
    db.execute<{ source: string; n: number }>(sql`select source, count(*)::int as n from timeline_entries where origin = 'dataset' group by source`),
  ])
  const bySource = new Map([...counts].map((row) => [row.source, row.n]))
  const morning = recordedMorning()
  const auto = rows.filter((row) => row.level === "auto")
  const approval = rows.filter((row) => row.level === "approval")
  const never = rows.filter((row) => row.level === "never")
  const locked = rows.filter((row) => row.locked && row.level !== "auto")

  const longest = morning?.investigator.longestOrderId
    ? (await db.select({ reference: orders.reference }).from(orders).where(eq(orders.id, morning.investigator.longestOrderId)).limit(1))[0]?.reference ?? null : null
  return <main className="content wide how">
    <div className="page-head"><div><h1>Settings</h1><p className="page-sub">What agents may do on their own, what they learn from your corrections, and how it all works.</p></div></div>
    <SettingsNav current="how" />

    <p className="lead">Agents do the legwork in the background. A person sees only what needs a person, as a ready decision: what happened, what the agent already found out (every fact with its source and time), what it proposes, and the buttons. Nothing that books, costs money, changes a date or contacts a customer happens without your yes.</p>

    <section className="how-section" aria-label="The flow">
      <h2 className="section-title">From a message to a decision</h2>
      <div className="dg-wrap"><Flow /></div>
      <p className="note dg-legend"><span className="dg-key model" /> a model <span className="dg-key code" /> code, no model <span className="dg-key person" /> a person</p>
      <ol className="how-steps">
        {STEPS.map((step, index) => <li key={step.title}>
          <span className="how-n num">{index + 1}</span>
          <div><b>{step.title}</b>{step.who && <span className="faint"> · {step.who}</span>}<p>{step.text}</p></div>
        </li>)}
      </ol>
    </section>

    <section className="how-section" aria-label="Where the information comes from">
      <h2 className="section-title">Where the information comes from</h2>
      <p className="note how-note">Everything here is fictional. In this copy the records are a fixed snapshot and every outside party is simulated; in production each kind would come from the system that already holds it.</p>
      <div className="how-table" role="table">
        <div className="how-tr head" role="row"><span role="columnheader">Information</span><span role="columnheader">Here, today</span><span role="columnheader">In production, from</span></div>
        {SOURCES.map((source) => {
          const n = source.key.reduce((sum, key) => sum + (bySource.get(key) ?? 0), 0)
          return <div className="how-tr" role="row" key={source.what}>
            <span role="cell"><b>{source.what}</b>{n > 0 && <span className="sub num">{n.toLocaleString("en-GB")} on the timelines</span>}</span>
            <span role="cell">{source.today}</span>
            <span role="cell">{source.production}</span>
          </div>
        })}
      </div>
    </section>

    <section className="how-section" aria-label="Which model does what">
      <h2 className="section-title">Who does which job, and why</h2>
      <div className="how-table two" role="table">
        <div className="how-tr head" role="row"><span role="columnheader">Job</span><span role="columnheader">Who</span><span role="columnheader">Why</span></div>
        {[
          ["Urgency, deadlines, routing, permissions, carrying out an approved action", "Code", "Rules and arithmetic must be exact, the same every time, and checkable. A model is not needed for them."],
          ["Reading every message once", modelName(ROLE_MODEL.classifier), "The smallest, fastest model is enough to tell what a message is about and pull out what it says."],
          ["Investigating a case and writing the card", modelName(ROLE_MODEL.investigator), "Works with tools in a loop (read, ask, look up) and writes plain cards. Good enough for most cases, at a fraction of the larger model's price."],
          ["The hard cases: safety, a cost over €500, records that disagree", modelName(ROLE_MODEL.investigatorSenior), "The strongest model where a mistake costs most. Code moves the case to it; the agent does not decide that alone."],
          ["Checking every card against its sources", modelName(ROLE_MODEL.verifier), "A second, independent read of each fact before a person sees it."],
          ["Answering drivers' routine questions", modelName(ROLE_MODEL.driverSupport), "Answers from the order's own records, in the driver's language; hands anything else to the Investigator."],
          ["One plain sentence per run on the Agents page", modelName(ROLE_MODEL.narrator), "Short summaries of what code already recorded."],
        ].map(([job, who, why]) => <div className="how-tr" role="row" key={job}><span role="cell">{job}</span><span role="cell"><b>{who}</b></span><span role="cell">{why}</span></div>)}
      </div>
    </section>

    <section className="how-section" aria-label="What agents may do alone">
      <h2 className="section-title">What the agent may do alone, and what needs your yes</h2>
      <div className="how-columns">
        <div>
          <h3>On its own</h3>
          <ul className="how-list">{auto.map((row) => <li key={row.action}>{row.label}{row.limitEur ? `, up to €${row.limitEur}` : ""}</li>)}</ul>
        </div>
        <div>
          <h3>Asks you first</h3>
          <ul className="how-list">{approval.map((row) => <li key={row.action}>{row.label}</li>)}</ul>
          {never.length > 0 && <><h3>Never</h3><ul className="how-list">{never.map((row) => <li key={row.action}>{row.label}</li>)}</ul></>}
        </div>
      </div>
      <p className="note how-note">This is the live table that code checks before every action: the agents cannot change it, and no agent has a tool that books, pays or writes to a customer. {locked.length} actions can never become automatic: {locked.map((row) => row.label.toLowerCase()).join(", ")}. The rest can, when you choose it in <Link className="link" href="/settings">Agent permissions</Link> or accept a suggestion after enough approvals.</p>
    </section>

    {morning && <section className="how-section" aria-label="Measured">
      <h2 className="section-title">Measured on the recorded morning</h2>
      <p className="note how-note">The agents' first pass over the snapshot, recorded so this copy shows real agent work without an API key: {morning.orders.investigated} orders with something open, each investigated; the other orders checked by code. It covered {at(morning.simulatedFrom, DESK_ZONE)} to {at(morning.simulatedTo, DESK_ZONE).replace(/^\w+ \d+ \w+ /, "")} in the app's simulated time{morning.wallMinutes ? ` and took ${Math.round(morning.wallMinutes)} minutes of real time, 4 investigations at a time` : ""}.</p>
      <dl className="how-stats">
        <div><dt>Investigations</dt><dd className="num">{morning.investigator.runs}</dd><p>{morning.investigator.cards} became a card for a person; {morning.investigator.closed} were closed without one because the records explained them.</p></div>
        <div><dt>Model mix</dt><dd className="num">{morning.investigator.sonnet} · {morning.investigator.opus}</dd><p>{morning.investigator.sonnet} stayed on {modelName(ROLE_MODEL.investigator)}; {morning.investigator.opus} ended on {modelName(ROLE_MODEL.investigatorSenior)}: {morning.investigator.safety} for safety from the start, {morning.investigator.conflict} because the Verifier found two records that disagree, {morning.investigator.overCost} over €500.</p></div>
        <div><dt>Cost per investigation</dt><dd className="num">{usd(morning.investigator.averageUsd)}</dd><p>On average, {usd(morning.investigator.totalUsd)} for all {morning.investigator.runs}, checks and simulated replies included. Reading {morning.classifier.messages} messages cost {usd(morning.classifier.usd)} in all.</p></div>
        <div><dt>Time per investigation</dt><dd className="num">{Math.round(morning.investigator.medianSeconds)} s</dd><p>The median, real time. The longest took {Math.round(morning.investigator.maxSeconds)} s{longest ? `, on ${longest}` : ""}. Closing a case without a card took {Math.round(morning.investigator.closeSeconds[0])}–{Math.round(morning.investigator.closeSeconds[1])} s.</p></div>
      </dl>
      <p className="note how-note">Every model call that morning, {morning.all.runs} agent runs in all, cost {usd(morning.all.usd)}: {usd(morning.all.opusUsd)} on {modelName(ROLE_MODEL.investigatorSenior)}, {usd(morning.all.sonnetUsd)} on {modelName(ROLE_MODEL.investigator)}, {usd(morning.all.haikuUsd)} on {modelName(ROLE_MODEL.classifier)}. Each run, with every step and its cost, is on the <Link className="link" href="/agents?show=done">Agents</Link> page. Source: the recorded runs, exported {at(morning.exportedAt, DESK_ZONE)}.</p>
    </section>}
  </main>
}
