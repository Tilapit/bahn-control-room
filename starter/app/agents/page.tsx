import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { hasApiKey } from "@/lib/agents/llm"
import { agentsOverview, agentsView, dollars, type OverviewRow, type RunFilter, tokenWords } from "@/lib/agents-view"
import { now as clockNow } from "@/lib/clock"
import { holdings } from "@/lib/queue"
import { orderRoutes, teamOf } from "@/lib/team-data"
import type { Team } from "@/lib/teams"
import { clock } from "@/lib/time"
import { Icon } from "../ui/icons"
import { AnyInView, CountInView, CrossBorder, NoneInView, TeamGroup, TeamList, type TeamRow, ViewSwitcher } from "../ui/view-switcher"
import { When } from "../ui/when"
import { CountWords, ShowMore } from "./show-more"
import "./agents.css"

export const metadata: Metadata = { title: "Agents" }

type Props = { searchParams: Promise<{ show?: string }> }

const DESK_ZONE = "Europe/Helsinki"
const FILTERS: { key: RunFilter; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "done", label: "Done" },
  { key: "quiet", label: "Quiet checks" },
]

const EMPTY: Record<RunFilter, { title: string; text: string }> = {
  active: { title: "No agent is working right now.", text: "When a message, an alert or a monitor rule needs a look, an agent picks it up and shows here while it works." },
  done: { title: "No finished runs yet.", text: "Finished runs show here: an agent that settled an order on its own, and proposals you decided." },
  quiet: { title: "No quiet checks yet.", text: "Orders with nothing open are checked by code, without a model, and show here." },
}

type Row = Awaited<ReturnType<typeof agentsView>>["rows"][number] & { team: Team }

/** One run as a list row; the list around it decides whether the person's view shows it. */
function RunRow({ row, now, label = true }: { row: Row; now: string; label?: boolean }) {
  return <Link className="run-row" href={`/agents/${row.id}`}>
      <span className={`run-state ${row.status}`}><span className="dot" aria-hidden="true" /></span>
      <span className="run-main">
        <span className="run-top">
          {label ? <span className={`run-label ${row.status}`}>{row.statusLabel}</span> : <span className="sr-only">{row.statusLabel}</span>}
          <span className="run-agent">{row.agent}</span>
          {row.reference && <span className="run-order">{row.reference}{row.car ? ` · ${row.car}` : ""}</span>}
          {row.safety && <span className="tag safety">Safety</span>}
          <CrossBorder team={row.team} />
          {row.replay && <span className="replay-tag">Replay</span>}
        </span>
        <span className="run-sentence">{row.sentence}</span>
        <span className="run-meta num">
          {row.model === "Code" ? "Code, no model" : `${row.model} · ${tokenWords(row.tokens)} · ${dollars(row.costUsd)} model cost`}
          {" · "}started <When iso={row.startedAt} now={now} zone={DESK_ZONE} />
          {row.nextCheckAt && <> · next check <When iso={row.nextCheckAt} now={now} zone={DESK_ZONE} /></>}
        </span>
      </span>
    </Link>
}

const teamRows = (rows: Row[], now: string, label = true): TeamRow[] => rows.map((row) => ({ key: row.id, team: row.team, node: <RunRow row={row} now={now} label={label} /> }))

/**
 * Active runs in three groups: the agents' own work, what waits for a person (also on For you), and
 * what agents handle without anyone ("Watching", For you's "agents are handling"). Under a group heading
 * a row needs no status of its own. Done puts the Classifier's message reading, many similar lines, in a fold.
 */
function RunGroups({ filter, rows, now }: { filter: RunFilter; rows: Row[]; now: string }) {
  if (filter === "active") {
    // The agents' own work first; what waits for a person is one row: the proposals themselves are on For you.
    const groups = [
      { key: "working", title: "Working now", note: "", rows: rows.filter((row) => row.status === "running"), label: false },
      { key: "driver", title: "Waiting for driver", note: "asked a driver or a site, waiting for the reply", rows: rows.filter((row) => row.status === "waiting_driver" || row.status === "waiting_site"), label: true },
      { key: "paused", title: "Paused", note: "you took these orders over; the agent continues when you hand them back", rows: rows.filter((row) => row.status === "paused"), label: false },
    ].filter((item) => item.rows.length)
    const forYou = rows.filter((row) => row.status === "waiting_person")
    const watching = rows.filter((row) => row.statusLabel === "Watching")
    return <>
      {groups.map((item) => <TeamGroup key={item.key} title={item.title} note={item.note} rows={teamRows(item.rows, now, item.label)} />)}
      <AnyInView teams={forYou.map((row) => row.team)}><Link className="runs-collapsed" href="/">
        <span className="run-state waiting_person"><span className="dot" aria-hidden="true" /></span>
        <span><b>Waiting for you (<CountInView teams={forYou.map((row) => row.team)} />)</b> each is a proposal in your For you list</span>
        <span className="link">Open For you<Icon name="arrow" size={14} /></span>
      </Link></AnyInView>
      <TeamGroup title="Watching" note="agents are handling these without you and look again at the next check" rows={teamRows(watching, now, false)} />
      <NoneInView teams={rows.map((row) => row.team)} hint="Agents may be working on orders in other markets or at other desks." />
    </>
  }
  if (filter === "done") {
    const reading = rows.filter((row) => row.agent === "Classifier")
    const work = rows.filter((row) => row.agent !== "Classifier")
    return <>
      <TeamList rows={teamRows(work, now)} hint="Finished runs in other markets or at other desks are not shown." />
      <AnyInView teams={reading.map((row) => row.team)}><details className="runs-fold">
        <summary className="runs-group">Messages read by the Classifier (<CountInView teams={reading.map((row) => row.team)} />)</summary>
        <TeamList rows={teamRows(reading, now)} />
      </details></AnyInView>
    </>
  }
  return <TeamList rows={teamRows(rows, now)} hint="Quiet checks look over orders with nothing open, so they sit at no desk: pick All desks to see them." />
}

// ---------------------------------------------------------------------------
// The overview (design/agents.jpg): waiting, watching, done today, quiet checks, who the agents are
// ---------------------------------------------------------------------------

type Overview = Awaited<ReturnType<typeof agentsOverview>>
type ORow = OverviewRow & { team: Team }

/** The colour of an agent's dot: one muted colour per agent, the same in every list. */
function agentKey(agent: string): string {
  return agent === "Classifier" ? "classifier" : agent === "Investigator" ? "investigator" : agent === "Driver support" ? "driver" : agent === "Monitor" ? "monitor" : "other"
}

/** "10:12" today, "Tue 10:20" on another day, in Helsinki time like the rest of the page. */
function time(iso: string, now: string): string {
  const day = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: DESK_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value))
  if (day(iso) === day(now)) return clock(iso, DESK_ZONE)
  return `${new Intl.DateTimeFormat("en-GB", { timeZone: DESK_ZONE, weekday: "short" }).format(new Date(iso))} ${clock(iso, DESK_ZONE)}`
}

function modelWords(row: ORow): string {
  return row.model === "Code" ? "code, no model" : `${row.model} · ${tokenWords(row.tokens)} · ${dollars(row.costUsd)}`
}

/** A run the agents are watching: who, which order and car, the one sentence, and when it looks again. */
function WatchRow({ row, now }: { row: ORow; now: string }) {
  return <Link className="run-row ag-row" href={`/agents/${row.id}`}>
    <span className={`ag-dot ${agentKey(row.agent)}`} aria-hidden="true" />
    <span className="ag-main">
      <span className="ag-top">
        <b className="ag-agent">{row.agent}</b>
        {row.reference && <span className="ag-ref num">{row.reference}</span>}
        {row.car && <span className="ag-car">{row.car}</span>}
        {row.safety && <span className="tag safety">Safety</span>}
        <CrossBorder team={row.team} />
        {row.replay && <span className="replay-tag">Replay</span>}
      </span>
      <span className="ag-sentence">{row.sentence}</span>
      <span className="ag-meta num">
        {row.statusLabel !== "Watching" && <span className={`ag-state ${row.status}`}>{row.statusLabel} · </span>}
        Started {time(row.startedAt, now)}{row.nextCheckAt ? ` · next check ${time(row.nextCheckAt, now)}` : ""} · {modelWords(row)}
      </span>
    </span>
  </Link>
}

/** A run finished today without anyone: what it did, the order, and when it finished. */
function DoneRow({ row, now }: { row: ORow; now: string }) {
  return <Link className="run-row ag-done" href={`/agents/${row.id}`}>
    <Icon name="check" size={14} className="ag-check" />
    <span className="ag-done-text">{row.sentence}{row.reference && <span className="ag-ref num"> · {row.reference}</span>}</span>
    <span className="ag-time num">{time(row.finishedAt ?? row.startedAt, now)}</span>
  </Link>
}

const WHO = [
  { key: "classifier", name: "Classifier", model: "Haiku, the small model", text: "Reads every message once and notes what it says about which order: facts and agreements, marked as said, not confirmed." },
  { key: "investigator", name: "Investigator", model: "Sonnet; Opus for safety, costs over €500 or records that disagree", text: "Looks into an order with a problem, asks drivers and sites, looks up options, and brings you a proposal when something needs a yes." },
  { key: "driver", name: "Driver support", model: "Sonnet", text: "Answers drivers' routine questions in their language and hands the hard ones to the Investigator." },
  { key: "monitor", name: "Monitor", model: "Rules in code, no model", text: "Watches positions, bookings, deadlines and disruption notices, and starts an Investigator before anyone reports a problem." },
]

async function OverviewPage({ view }: { view: Overview }) {
  const held = await holdings(new Date(view.now))
  const all = [...view.waiting, ...view.watching, ...view.doneToday]
  const routes = await orderRoutes([...new Set(all.map((row) => row.orderId).filter((id): id is string => !!id))])
  const files = new Map(held.files.map((file) => [file.order.id, file]))
  const withTeam = (row: OverviewRow): ORow => ({
    ...row, team: teamOf(row.orderId ? routes.get(row.orderId) : undefined, row.orderId ? held.cardOf.get(row.orderId) ?? null : null, row.orderId ? files.get(row.orderId) ?? null : null),
  })
  const waiting = view.waiting.map(withTeam)
  const watching = view.watching.map(withTeam)
  const done = view.doneToday.map(withTeam)
  const waitingTeams = waiting.map((row) => row.team)
  const watchRows: TeamRow[] = watching.map((row) => ({ key: row.id, team: row.team, node: <WatchRow row={row} now={view.now} /> }))
  const doneRows: TeamRow[] = done.map((row) => ({ key: row.id, team: row.team, node: <DoneRow row={row} now={view.now} /> }))
  return <>
    <div className="ag-head">
      <div>
        <h1>Agents</h1>
        <p className="page-sub">Today agents worked on <b>{view.today.orders} orders</b> and checked <b>{view.today.quietOrders.toLocaleString("en-GB")} more</b> with
          simple rules. <b><CountWords teams={waitingTeams} one="suggestion is" many="suggestions are" /></b> waiting for you.</p>
      </div>
      <ViewSwitcher />
    </div>
    <nav className="ag-chips" aria-label="Sections">
      <a className="ag-chip" href="#waiting">Waiting for you · <CountInView teams={waitingTeams} /></a>
      <a className="ag-chip" href="#watching">Watching · <CountInView teams={watching.map((row) => row.team)} /></a>
      <a className="ag-chip" href="#done">Done today · <CountInView teams={done.map((row) => row.team)} /></a>
      <a className="ag-chip" href="#quiet">Quiet checks · {view.quiet.runs.toLocaleString("en-GB")}</a>
      <a className="ag-chip" href="#who">Who the agents are</a>
    </nav>

    <AnyInView teams={waitingTeams}><section id="waiting" className="ag-banner" aria-label="Waiting for you">
      <span className="ag-badge num"><CountInView teams={waitingTeams} /></span>
      <span className="ag-banner-text">
        <b><CountWords teams={waitingTeams} one="suggestion is" many="suggestions are" /> waiting for your decision</b>
        <span>Each one is in For you, with what the agent found and what it wants to do.</span>
      </span>
      <Link className="btn primary" href="/">Open For you</Link>
    </section></AnyInView>

    <section id="watching" className="ag-section" aria-label="Watching">
      <h2>Watching · <CountInView teams={watching.map((row) => row.team)} /></h2>
      <p className="ag-sub">Agents are handling these without you and will look again at the next check. Open one to see every step.</p>
      <TeamList rows={watchRows} listClassName="ag-list" hint="Agents may be watching orders in other markets or at other desks." />
    </section>

    <section id="done" className="ag-section" aria-label="Done today">
      <h2>Done today · <CountInView teams={done.map((row) => row.team)} /></h2>
      <p className="ag-sub">Finished without anyone needing to step in.{view.classifierToday ? ` The Classifier also read ${view.classifierToday} messages today, one run each.` : ""} <Link href="/agents?show=done">Every finished run</Link></p>
      <ShowMore rows={doneRows} initial={3} className="ag-list ag-done-list" empty="Nothing finished today in this view." />
    </section>

    <section id="quiet" className="ag-section" aria-label="Quiet checks">
      <h2>Quiet checks · {view.quiet.runs.toLocaleString("en-GB")}</h2>
      <p className="ag-sub">Orders with nothing open, checked by code without a language model: alerts, tasks, incidents, handover claims, the support inbox and conversations. Nothing found.</p>
      <div className="ag-tiles">
        {view.quiet.groups.map((group) => <div className="ag-tile" key={group.key}>
          <b className="num">{group.n.toLocaleString("en-GB")}</b>
          <span>{group.label}</span>
        </div>)}
      </div>
      <p className="ag-model num">Model use today: {view.today.runs} runs, {tokenWords(view.today.tokens)}, {dollars(view.today.costUsd)}. Quiet checks cost nothing. <Link href="/agents?show=quiet">Each quiet check</Link></p>
    </section>

    <section id="who" className="ag-section" aria-label="Who the agents are">
      <h2>Who the agents are</h2>
      <div className="ag-who">
        {WHO.map((agent) => <div className="ag-who-card" key={agent.key}>
          <b><span className={`ag-dot ${agent.key}`} aria-hidden="true" />{agent.name}</b>
          <p>{agent.text}</p>
          <span className="ag-who-model">{agent.model}</span>
        </div>)}
      </div>
      <p className="ag-sub ag-more-agents">Two more work behind them: the Verifier checks every fact on a proposal against its source before you see it, and the Narrator writes the one line you read for each run here.</p>
    </section>
    <p className="ag-totop"><a href="#top">Back to top ↑</a></p>
  </>
}

export default async function Agents({ searchParams }: Props) {
  await connection()
  const { show } = await searchParams
  if (show !== "done" && show !== "quiet") {
    const view = await agentsOverview()
    return <main className="content narrow ag-page" id="top">
      {view.total === 0 ? <>
        <div className="ag-head"><div><h1>Agents</h1><p className="page-sub">What the agents are doing right now.</p></div><ViewSwitcher /></div>
        <div className="empty">
          <h2>No agent has run yet.</h2>
          <p>{hasApiKey() ? "Run the backfill (npm run agents:backfill) or play a scenario on the Demo page." : "Load the recorded runs with npm run fixtures:load, or add an API key to run agents live."}</p>
        </div>
      </> : <OverviewPage view={view} />}
    </main>
  }
  const filter: RunFilter = show
  const [{ now, rows: runRows, counts, today, more }, held] = await Promise.all([agentsView(filter), clockNow().then(holdings)])
  // Each run's order: its market and route, and the desk of its open card (none when nothing is open on it).
  const routes = await orderRoutes([...new Set(runRows.map((row) => row.orderId).filter((id): id is string => !!id))])
  const files = new Map(held.files.map((file) => [file.order.id, file]))
  const rows: Row[] = runRows.map((row) => ({
    ...row, team: teamOf(row.orderId ? routes.get(row.orderId) : undefined, row.orderId ? held.cardOf.get(row.orderId) ?? null : null, row.orderId ? files.get(row.orderId) ?? null : null),
  }))
  const nothingYet = counts.active + counts.done + counts.quiet === 0
  return <main className="content narrow">
    <div className="page-head">
      <div>
        <p className="ag-back"><Link href="/agents">← Agents</Link></p>
        <h1>{filter === "done" ? "Every finished run" : "Quiet checks, one sentence each"}</h1>
        <p className="page-sub">
          {nothingYet ? "What the agents are doing right now." : <>Today: <b>{today.runs} runs used a model</b>, {dollars(today.costUsd)} in model cost ({tokenWords(today.tokens)}); {today.codeRuns} more ran as code without a model{today.codeRuns > today.quietRuns ? ` (${today.quietRuns} quiet checks, ${today.codeRuns - today.quietRuns} by the Monitor's rules)` : ""}. Run times in Helsinki time.</>}
        </p>
        <ViewSwitcher />
      </div>
    </div>
    {nothingYet ? <div className="empty">
      <h2>No agent has run yet.</h2>
      <p>{hasApiKey() ? "Run the backfill (npm run agents:backfill) or play a scenario on the Demo page." : "Load the recorded runs with npm run fixtures:load, or add an API key to run agents live."}</p>
    </div> : <>
      <nav className="filters" aria-label="Show runs">
        {FILTERS.map((item) => <Link key={item.key} href={item.key === "active" ? "/agents" : `/agents?show=${item.key}`} className="filter" aria-pressed={filter === item.key}>
          {item.label}<span className="n num">{counts[item.key]}</span>
        </Link>)}
      </nav>
      {filter === "quiet" && rows.length > 0 && <p className="note runs-note">Checked by code only, no model: these orders have no open alert, task, incident, claim or unanswered message.</p>}
      {rows.length === 0 ? <div className="empty"><h2>{EMPTY[filter].title}</h2><p>{EMPTY[filter].text}</p></div>
        : <RunGroups filter={filter} rows={rows} now={now} />}
      {more > 0 && <p className="queue-end">And {more.toLocaleString("en-GB")} more quiet checks, older; each order is on the Orders page.</p>}
    </>}
  </main>
}
