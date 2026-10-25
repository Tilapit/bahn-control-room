import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { hasApiKey } from "@/lib/agents/llm"
import { agentsView, dollars, type RunFilter, tokenWords } from "@/lib/agents-view"
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
  done: { title: "No finished runs yet.", text: "Runs that closed a case or put a card in front of you and were decided show here." },
  quiet: { title: "No quiet checks yet.", text: "Orders with nothing open are checked by code, without a model, and show here." },
}

export default async function Agents({ searchParams }: Props) {
  await connection()
  const { show } = await searchParams
  const filter: RunFilter = show === "done" || show === "quiet" ? show : "active"
  const { now, rows, counts, today } = await agentsView(filter)
  const nothingYet = counts.active + counts.done + counts.quiet === 0
  return <main className="content narrow">
    <div className="page-head">
      <div>
        <h1>Agents</h1>
        <p className="page-sub">
          {nothingYet ? "What the agents are doing right now." : <>Today: <b>{today.runs} runs used a model</b>, {dollars(today.costUsd)} in model cost ({tokenWords(today.tokens)}); {today.codeRuns} more were checks by code. Times in Helsinki time.</>}
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
        : <ol className="runs">
          {rows.map((row, index) => <li key={row.id}>
            {/* Active runs in two groups: the agents' own work, then what waits for a person (also on For you). */}
            {filter === "active" && (index === 0 || (rows[index - 1].status === "waiting_person") !== (row.status === "waiting_person"))
              ? <p className="runs-group">{row.status === "waiting_person" ? `Waiting for you (${rows.filter((item) => item.status === "waiting_person").length}): each has a proposal on For you` : "Working now"}</p> : null}
            <Link className="run-row" href={`/agents/${row.id}`}>
              <span className={`run-state ${row.status}`}><span className="dot" aria-hidden="true" />{row.statusLabel}</span>
              <span className="run-main">
                <span className="run-top">
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
          </li>)}
        </ol>}
    </>}
  </main>
}
