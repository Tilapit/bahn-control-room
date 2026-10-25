import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { hasApiKey } from "@/lib/agents/llm"
import { agentsView, dollars, type RunFilter, tokenWords } from "@/lib/agents-view"
import { Icon } from "../ui/icons"
import { When } from "../ui/when"

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

type Row = Awaited<ReturnType<typeof agentsView>>["rows"][number]

function RunRow({ row, now, label = true }: { row: Row; now: string; label?: boolean }) {
  return <li>
    <Link className="run-row" href={`/agents/${row.id}`}>
      <span className={`run-state ${row.status}`}><span className="dot" aria-hidden="true" /></span>
      <span className="run-main">
        <span className="run-top">
          {label ? <span className={`run-label ${row.status}`}>{row.statusLabel}</span> : <span className="sr-only">{row.statusLabel}</span>}
          <span className="run-agent">{row.agent}</span>
          {row.reference && <span className="run-order">{row.reference}{row.car ? ` · ${row.car}` : ""}</span>}
          {row.safety && <span className="tag safety">Safety</span>}
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
  </li>
}

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
      {groups.map((item) => <section key={item.key}>
        <p className="runs-group">{item.title} ({item.rows.length}){item.note ? `: ${item.note}` : ""}</p>
        <ol className="runs">{item.rows.map((row) => <RunRow key={row.id} row={row} now={now} label={item.label} />)}</ol>
      </section>)}
      {forYou.length > 0 && <Link className="runs-collapsed" href="/">
        <span className="run-state waiting_person"><span className="dot" aria-hidden="true" /></span>
        <span><b>Waiting for you ({forYou.length})</b> each is a proposal in your For you list</span>
        <span className="link">Open For you<Icon name="arrow" size={14} /></span>
      </Link>}
      {watching.length > 0 && <section>
        <p className="runs-group">Watching ({watching.length}): agents are handling these without you and look again at the next check</p>
        <ol className="runs">{watching.map((row) => <RunRow key={row.id} row={row} now={now} label={false} />)}</ol>
      </section>}
    </>
  }
  if (filter === "done") {
    const reading = rows.filter((row) => row.agent === "Classifier")
    const work = rows.filter((row) => row.agent !== "Classifier")
    return <>
      <ol className="runs">{work.map((row) => <RunRow key={row.id} row={row} now={now} />)}</ol>
      {reading.length > 0 && <details className="runs-fold">
        <summary className="runs-group">Messages read by the Classifier ({reading.length})</summary>
        <ol className="runs">{reading.map((row) => <RunRow key={row.id} row={row} now={now} />)}</ol>
      </details>}
    </>
  }
  return <ol className="runs">{rows.map((row) => <RunRow key={row.id} row={row} now={now} />)}</ol>
}

export default async function Agents({ searchParams }: Props) {
  await connection()
  const { show } = await searchParams
  const filter: RunFilter = show === "done" || show === "quiet" ? show : "active"
  const { now, rows, counts, today, more } = await agentsView(filter)
  const nothingYet = counts.active + counts.done + counts.quiet === 0
  return <main className="content narrow">
    <div className="page-head">
      <div>
        <h1>Agents</h1>
        <p className="page-sub">
          {nothingYet ? "What the agents are doing right now." : <>Today: <b>{today.runs} runs used a model</b>, {dollars(today.costUsd)} in model cost ({tokenWords(today.tokens)}); {today.codeRuns} more ran as code without a model{today.codeRuns > today.quietRuns ? ` (${today.quietRuns} quiet checks, ${today.codeRuns - today.quietRuns} by the Monitor's rules)` : ""}. Run times in Helsinki time.</>}
        </p>
        <p className="page-explain">The Classifier reads every message, the Investigator looks into an order with a problem, Driver support answers drivers,
          the Monitor&apos;s rules watch the feeds and the cars, and quiet checks look over orders with nothing open. Open a row to see every step.</p>
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
      {rows.length > 0 && filter === "active" && <p className="queue-end">Finished runs are under Done; the checks code makes on quiet orders are under Quiet checks.</p>}
    </>}
  </main>
}
