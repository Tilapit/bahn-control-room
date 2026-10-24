import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { connection } from "next/server"
import { dollars, RUN_STATUS, runTrace, tokenWords } from "@/lib/agents-view"
import { getCase } from "@/lib/case"
import { now as clockNow } from "@/lib/clock"
import { modelName } from "@/lib/models"
import { orderView } from "@/lib/queue"
import { When } from "../../ui/when"

export const metadata: Metadata = { title: "Agent run" }

type Props = { params: Promise<{ runId: string }> }

const KIND_LABEL = { thought: "Reasoning", action: null, reply: "Reply", card: "Outcome" } as const

/** Why the run moved to Opus, in code's words; the verifier's own note is behind a disclosure. */
function escalationLine(reason: string): string {
  if (reason.startsWith("Safety")) return "On Opus from the start: a person's safety may be involved."
  if (reason.startsWith("Conflicting evidence")) return "Moved to Opus: the verifier found two records that disagree about something the card states."
  if (/over €500/.test(reason)) return `Moved to Opus: the proposal costs ${reason.match(/€\d[\d,]*/)?.[0] ?? "more than €500"}, over the €500 limit for Sonnet.`
  return `Moved to Opus: ${reason}`
}

/** "48 s", "2 min 05 s": real time the agent worked. */
function seconds(ms: number): string {
  const total = Math.round(ms / 1000)
  return total < 120 ? `${total} s` : `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, "0")} s`
}

/** The first sentence or so of a long reasoning summary; the rest opens on request. */
function lead(text: string): { head: string; rest: string } {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= 220) return { head: flat, rest: "" }
  const cut = flat.slice(0, 220).lastIndexOf(". ")
  const at = cut > 80 ? cut + 1 : 220
  return { head: flat.slice(0, at).trim(), rest: flat.slice(at).trim() }
}

export default async function RunPage({ params }: Props) {
  await connection()
  const { runId } = await params
  const trace = await runTrace(runId)
  if (!trace) notFound()
  const { run, steps, cards, reference } = trace
  const [file, at] = await Promise.all([run.orderId ? getCase(run.orderId) : Promise.resolve(null), clockNow()])
  const now = at.toISOString()
  const zone = file ? orderView(file).zone : "Europe/Helsinki"
  const zoneCity = file ? (file.order.pickedUpAt ? file.order.route.to?.city : file.order.route.from?.city) : "Helsinki"
  const usage = Object.entries(run.modelUsage ?? {}).sort((a, b) => b[1].costUsd - a[1].costUsd)
  return <main className="content narrow">
    <div className="crumbs"><Link href="/agents">Agents</Link><span>/</span>{reference ? <Link href={`/orders/${reference}`}>{reference}</Link> : <span>No order</span>}</div>
    <div className="run-head">
      <h1 className="case-title">{run.agent}{file && <span className="ref">{file.order.reference} · {file.order.car.label}</span>}{run.replay && <span className="replay-tag">Replay of a recorded run</span>}</h1>
      <p className="case-status">{run.narration ?? run.outcomeSummary ?? "Working on it."}</p>
      <div className="case-meta">
        <span>{RUN_STATUS[run.status] ?? run.status}</span>
        <span>{trace.modelLine === "Code" ? "Code, no model" : trace.modelLine}</span>
        {run.model && <span className="num">{tokenWords(trace.tokens)} · {dollars(run.costUsd)}</span>}
        {run.wallMs > 0 && <span className="num">worked {seconds(run.wallMs)}</span>}
        <span>started <When iso={run.startedAt.toISOString()} now={now} zone={zone} /></span>
        {run.nextCheckAt && <span>next check <When iso={run.nextCheckAt.toISOString()} now={now} zone={zone} /></span>}
      </div>
    </div>

    <section className="run-section">
      <h2 className="section-title">Why it started</h2>
      <p>{run.trigger}</p>
      {run.escalation && <div className="note" style={{ marginTop: 6 }}>{escalationLine(run.escalation)}{!run.escalation.startsWith("Safety") && <details className="more"><summary>Show the reason as recorded</summary><p>{run.escalation}</p></details>}</div>}
    </section>

    {cards.length > 0 && <section className="run-section">
      <h2 className="section-title">{cards.length === 1 ? "Card for a person" : "Cards for a person"}</h2>
      <ul className="run-cards">
        {cards.map((card) => <li key={card.id}>
          <Link className="link" href={reference ? `/orders/${reference}` : "/"}>{card.headline}</Link>
          <span className="faint"> · {card.status === "open" ? "waiting for you" : card.status === "expired" ? "replaced by a newer card" : card.status}</span>
        </li>)}
      </ul>
    </section>}

    <section className="run-section">
      <h2 className="section-title">What it did<span className="count">times in {zoneCity ?? "local"} time</span></h2>
      {steps.length === 0 ? <p className="muted">No steps yet.</p> : <ol className="trace">
        {steps.map((step) => {
          const text = step.kind === "thought" ? lead(step.text) : null
          return <li key={step.idx} className={`trace-step ${step.kind}${step.error ? " error" : ""}`}>
            <span className="entry-time"><When iso={step.at} now={now} zone={zone} as="clock" /></span>
            <div>
              {(step.error || KIND_LABEL[step.kind]) && <span className="trace-kind">{step.error ? "Not accepted" : KIND_LABEL[step.kind]}</span>}
              {text ? <div className="trace-text">{text.head}{text.rest && <details className="more"><summary>Show all reasoning</summary><p>{text.rest}</p></details>}</div>
                : <p className="trace-text">{step.text}</p>}
              {step.details != null && <details className="more"><summary>Show details</summary><pre className="raw">{JSON.stringify(step.details, null, 2)}</pre></details>}
            </div>
          </li>
        })}
      </ol>}
    </section>

    {usage.length > 0 && <section className="run-section">
      <h2 className="section-title">Models and cost</h2>
      <ul className="usage num">
        {usage.map(([model, item]) => <li key={model}>
          <span>{modelName(model)}</span>
          <span className="muted">{item.calls} call{item.calls === 1 ? "" : "s"} · {tokenWords(item.input + item.output + item.cacheRead + item.cacheWrite)} ({tokenWords(item.cacheRead).replace(" tokens", "")} read from cache) · {dollars(item.costUsd)}</span>
        </li>)}
      </ul>
      <p className="note" style={{ marginTop: 6 }}>Haiku calls inside a run are the verifier, the simulated driver or site, and the narrator. Cost is computed from the token counts and the prices in the code.</p>
    </section>}
  </main>
}
