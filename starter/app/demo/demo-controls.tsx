"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"
import type { DemoEvent } from "@/lib/demo-scenarios"
import { clock, at as fullTime } from "@/lib/time"

type State = {
  now: string
  start: string
  autoReply: boolean
  replay: { scenario: string; order: string; startedAt: string; durationMs: number } | null
  driver: string | null
  thread: { id: string; at: string; who: string; mine: boolean; text: string; simulated: boolean }[]
  runs: { id: string; agent: string; status: string; outcome: string | null; startedAt: string; reference: string | null }[]
}

const STATUS: Record<string, string> = { running: "Working", waiting_driver: "Waiting for driver", waiting_site: "Waiting for site", waiting_person: "Waiting for you", done: "Done", failed: "Stopped" }
const DESK_ZONE = "Europe/Helsinki"

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`

export function DemoControls({ events, orders, defaultOrder, live }: { events: (DemoEvent & { recorded: boolean })[]; orders: { reference: string; label: string }[]; defaultOrder: string; live: boolean }) {
  const router = useRouter()
  const [order, setOrder] = useState(defaultOrder)
  const [state, setState] = useState<State | null>(null)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const lastMessage = state?.thread[state.thread.length - 1]?.id
  // Like a chat: the newest message is in view.
  useEffect(() => { threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight }) }, [lastMessage])

  const load = useCallback(async () => {
    const response = await fetch(`/api/demo/state?order=${encodeURIComponent(order)}`, { cache: "no-store" })
    if (response.ok) setState(await response.json() as State)
  }, [order])

  useEffect(() => {
    void load()
    const timer = setInterval(load, 2000)
    return () => clearInterval(timer)
  }, [load])

  async function post(path: string, body: unknown, label: string) {
    setBusy(label)
    setNotice(null)
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const result = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) setNotice(result.error ?? "That did not work.")
      await load()
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || !state?.driver) return
    setDraft("")
    await post("/api/ingest", { order, source: "driver_chat", channel: "driver_chat", authorType: "driver", authorLabel: state.driver, body: text, demoKind: "driver phone" }, "send")
  }

  return <div className="demo">
    <section className="demo-block" aria-label="Simulated clock">
      <div className="section-title"><span>Simulated clock</span></div>
      <div className="demo-row">
        <span className="demo-clock num">{state ? `${fullTime(state.now, DESK_ZONE)}` : "…"}</span>
        <button type="button" className="btn small" disabled={!!busy} onClick={() => post("/api/demo/clock", { minutes: 15 }, "clock")}>+15 min</button>
        <button type="button" className="btn small" disabled={!!busy} onClick={() => post("/api/demo/clock", { minutes: 60 }, "clock")}>+1 h</button>
        <button type="button" className="btn small quiet" disabled={!!busy} onClick={() => post("/api/demo/clock", { reset: true }, "clock")}>Back to the start{state ? ` (${fullTime(state.start, DESK_ZONE)})` : ""}</button>
      </div>
      <label className="demo-switch">
        <input type="checkbox" checked={state?.autoReply ?? true} onChange={(event) => post("/api/demo/settings", { autoReply: event.target.checked }, "switch")} />
        <span>The simulated driver and sites answer agent questions by themselves. Turn off to answer as the driver on the phone below.</span>
      </label>
    </section>

    <section className="demo-block" aria-label="Scripted events">
      <div className="section-title"><span>Scripted events</span></div>
      {!live && <p className="note">No API key is set, so agents cannot run live. Replay plays back a recorded live run of the same event at its real speed, marked as a replay.</p>}
      {state?.replay && <p className="replay-status" role="status"><span className="replay-tag">Replay</span> Playing back a recorded live run on {state.replay.order}: {mmss(Math.min(state.replay.durationMs, Date.now() - Date.parse(state.replay.startedAt)))} of {mmss(state.replay.durationMs)}. Watch it on For you, the order page or Agents.</p>}
      <ul className="demo-events">
        {events.map((event) => <li key={event.id}>
          <div><div className="demo-event-title">{event.label}</div><div className="note">{event.detail}</div></div>
          <div className="demo-row">
            {event.recorded && <button type="button" className="btn small" disabled={!!busy} title="Plays back the rows a live run of this event wrote, at the speed they were written." onClick={() => post("/api/demo/event", { id: event.id, mode: "replay" }, `${event.id}:replay`)}>{busy === `${event.id}:replay` ? "Starting…" : "Replay recorded run"}</button>}
            <button type="button" className={`btn small${live ? "" : " quiet"}`} disabled={!!busy || !live} title={live ? "Real agents, with the simulated driver." : "Needs an API key."} onClick={() => post("/api/demo/event", { id: event.id, mode: "live" }, event.id)}>{busy === event.id ? "Starting…" : "Play live"}</button>
          </div>
        </li>)}
      </ul>
      {notice && <p className="note" role="alert">{notice}</p>}
    </section>

    <div className="demo-grid">
      <section className="demo-block" aria-label="Driver phone">
        <div className="section-title"><span>Driver phone (mock)</span></div>
        <select className="demo-select" value={order} onChange={(event) => setOrder(event.target.value)} aria-label="Order">
          {orders.map((item) => <option key={item.reference} value={item.reference}>{item.label}</option>)}
        </select>
        <div className="phone">
          <div className="phone-head">{state?.driver ?? "No driver"} · driver app</div>
          <div className="phone-thread" ref={threadRef}>
            {state?.thread.slice(-12).map((message) => <div key={message.id} className={`bubble${message.mine ? " mine" : ""}`}>
              <div className="bubble-who">{message.mine ? "You" : message.who}{message.simulated && message.mine ? " · simulated" : ""} · {clock(message.at, DESK_ZONE)}</div>
              <div>{message.text}</div>
            </div>)}
            {state && !state.thread.length && <p className="note">No messages on this order yet.</p>}
          </div>
          <form className="reply" onSubmit={send}>
            <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={state?.driver ? `Write as ${state.driver}` : "No driver on this order"} aria-label="Message as the driver" disabled={!state?.driver} />
            <button type="submit" className="btn small" disabled={!draft.trim() || !!busy}>Send</button>
          </form>
        </div>
      </section>
      <section className="demo-block" aria-label="Agent activity">
        <div className="section-title"><span>What the agents are doing</span></div>
        <ul className="demo-runs">
          {state?.runs.map((run) => <li key={run.id}>
            <div className="demo-run-head"><b>{run.agent}</b> · {run.reference ?? "no order"} · <span className={run.status === "running" ? "working" : ""}>{STATUS[run.status] ?? run.status}</span></div>
            {run.outcome && <div className="note">{run.outcome}</div>}
          </li>)}
          {state && !state.runs.length && <li className="note">No agent has run yet.</li>}
        </ul>
      </section>
    </div>
  </div>
}
