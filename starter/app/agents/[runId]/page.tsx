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

/** "Backfill. Open signals…": the morning catch-up, in words. */
function triggerWords(trigger: string): string {
  return trigger.replace(/^Backfill\.\s*/, "Catch-up when the demo day started: an agent looked at every order with something open. ")
}

/** Why the run moved to Opus, in code's words; the verifier's own note is behind a disclosure. */
function escalationLine(reason: string): string {
  if (reason.startsWith("Safety")) return "On Opus from the start: a person's safety may be involved."
  if (reason.startsWith("Conflicting evidence")) return "Moved to Opus, the larger model: two records disagree about something the proposal states."
  if (/over €500/.test(reason)) return `Moved to Opus: the proposal costs ${reason.match(/€\d[\d,]*/)?.[0] ?? "more than €500"}, over the €500 limit for Sonnet.`
  return `Moved to Opus: ${reason}`
}

/** "48 s", "2 min 05 s": real time the agent worked. */
function seconds(ms: number): string {
  const total = Math.round(ms / 1000)
  return total < 120 ? `${total} s` : `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, "0")} s`
}

type Step = NonNullable<Awaited<ReturnType<typeof runTrace>>>["steps"][number]

/** Reasoning steps folded into the step that follows them (the last one keeps any that come after it). */
function withReasoning(steps: Step[]): { step: Step; reasoning: string[] }[] {
  const out: { step: Step; reasoning: string[] }[] = []
  let pending: string[] = []
  for (const step of steps) {
    if (step.kind === "thought") {
      const flat = step.text.replace(/\s+/g, " ").trim()
      if (flat) pending.push(/[.!?…)]$/.test(flat) ? flat : `${flat}…`)
      continue
    }
    out.push({ step, reasoning: pending })
    pending = []
  }
  if (pending.length && out.length) out[out.length - 1].reasoning.push(...pending)
  return out
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
        <span>started <When iso={run.startedAt.toISOString()} now={now} zone={zone} /></span>
        {run.finishedAt && <span>last step <When iso={run.finishedAt.toISOString()} now={now} zone={zone} as="clock" /></span>}
        {run.wallMs > 0 && <span className="num" title="Real time the models worked; waiting for the driver or a site moves only the demo clock.">{seconds(run.wallMs)} of model time</span>}
        {reference && <Link className="link" href={`/orders/${reference}`}>Open order {reference}</Link>}
        {run.nextCheckAt && <span>next check <When iso={run.nextCheckAt.toISOString()} now={now} zone={zone} /></span>}
      </div>
    </div>

    <section className="run-section">
      <h2 className="section-title">Why it started</h2>
      <p>{triggerWords(run.trigger)}</p>
      {run.escalation && <div className="note" style={{ marginTop: 6 }}>{escalationLine(run.escalation)}{!run.escalation.startsWith("Safety") && <details className="more"><summary>Show the reason as recorded</summary><p>{run.escalation}</p></details>}</div>}
    </section>

    {cards.length > 0 && <section className="run-section">
      <h2 className="section-title">{cards.length === 1 ? "Proposal put to a person" : "Proposals put to a person"}</h2>
      <ul className="run-cards">
        {cards.map((card) => <li key={card.id}>
          <Link className="link" href={reference ? `/orders/${reference}` : "/"}>{card.headline}</Link>
          <span className="faint"> · {card.status === "open" ? "waiting for you" : card.status === "expired" ? "replaced by a newer proposal" : card.status}</span>
        </li>)}
      </ul>
    </section>}

    <section className="run-section">
      <h2 className="section-title">What it did<span className="count">times in {zoneCity ?? "local"} time</span></h2>
      {steps.length === 0 ? <p className="muted">No steps yet.</p> : <ol className="trace">
        {/* The model's own reasoning is raw working notes: it rides with the step it led to, one click away. */}
        {withReasoning(steps).map(({ step, reasoning }) => <li key={step.idx} className={`trace-step ${step.kind}${step.error ? " error" : ""}`}>
          <span className="entry-time"><When iso={step.at} now={now} zone={zone} as="clock" /></span>
          <div>
            {(step.error || KIND_LABEL[step.kind]) && <span className="trace-kind">{step.error ? "Sent back" : step.kind === "reply" && /^Moved to Opus/.test(step.text) ? "Handed to Opus" : KIND_LABEL[step.kind]}</span>}
            <p className="trace-text">{step.text}</p>
            {reasoning.length > 0 && <details className="more reasoning"><summary>Show the agent&apos;s reasoning</summary>{reasoning.map((text, index) => <p key={index}>{text}</p>)}</details>}
            {step.details != null && <details className="more"><summary>Show details</summary><pre className="raw">{JSON.stringify(step.details, null, 2)}</pre></details>}
          </div>
        </li>)}
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
      <p className="note" style={{ marginTop: 6 }}>Haiku calls inside a run are the second check of the proposal, the simulated driver or site, and the one-line summary. Cost is computed from the token counts and the model prices.</p>
    </section>}
  </main>
}
