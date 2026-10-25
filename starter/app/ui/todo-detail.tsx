"use client"

import { useEffect, useState } from "react"
import { simulatedCall } from "@/lib/sim-call"
import type { Todo } from "@/lib/todos"
import "./todo.css"

/** A new line of the simulated call every so often, like a conversation, not a wall of text. */
const LINE_MS = 1600

/**
 * "To do: call <contact>": a call the person approved and makes themselves. It stays until they log what happened;
 * the log goes on the order's timeline, the Classifier reads it, and the agent continues with it. Orders with a
 * demo script can play a simulated call instead (fictional, labelled); ending it logs a summary the same way.
 */
export function TodoDetail({ todo, onDone }: { todo: Todo; onDone: () => void }) {
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const script = simulatedCall(todo.reference)
  const [calling, setCalling] = useState(false)
  const [played, setPlayed] = useState(0)

  useEffect(() => {
    if (!calling || !script || played >= script.lines.length) return
    const timer = setTimeout(() => setPlayed((count) => count + 1), played === 0 ? 400 : LINE_MS)
    return () => clearTimeout(timer)
  }, [calling, played, script])

  async function send(path: "log" | "call", body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/todos/${encodeURIComponent(todo.id)}/${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      })
      const result = await response.json().catch(() => ({})) as { ok?: boolean; message?: string; error?: string }
      if (!response.ok || !result.ok) throw new Error(result.error ?? "The log was not saved.")
      setCalling(false)
      setDone(result.message ?? "Logged.")
      // Long enough to read what happened before For you moves on.
      setTimeout(onDone, 3500)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The log was not saved.")
    } finally {
      setBusy(false)
    }
  }

  return <article className="todo" aria-label={`To do: call ${todo.contact}`}>
    <header className="todo-head">
      <p className="todo-kicker">To do · {todo.reference}</p>
      <h2>Call {todo.contact}</h2>
      <p className="todo-meta">{todo.car} · {todo.route} · you approved this; the call is yours</p>
    </header>
    {todo.script && <details className="todo-script">
      <summary>Show call script</summary>
      <p>{todo.script}</p>
    </details>}

    {!done && script && !calling && <div className="todo-actions">
      <button type="button" className="btn" disabled={busy} onClick={() => { setPlayed(0); setCalling(true) }}>Call {todo.contact}</button>
      <span className="todo-hint">Simulated call: a scripted, fictional conversation for the demo, not a real phone.</span>
    </div>}

    {!done && script && calling && <section className="todo-call" aria-label="Simulated call" aria-live="polite">
      <p className="todo-call-head"><b>Simulated call</b> · fictional · with {script.them}</p>
      <ol className="todo-lines">
        {script.lines.slice(0, played).map((line, index) => <li key={index} data-who={line.who}>
          <span className="todo-who">{line.who === "you" ? "You" : script.them}</span>
          <span>{line.text}</span>
        </li>)}
        {played < script.lines.length && <li className="todo-typing" aria-hidden="true">…</li>}
      </ol>
      <div className="todo-actions">
        <button type="button" className="btn primary" disabled={busy || !script.lines.slice(0, played).some((line) => line.who === "them")}
          onClick={() => void send("call", { played })}>{busy ? "Summarising…" : "End call"}</button>
        <span className="todo-hint">On ending, Haiku summarises what was said onto the order&apos;s timeline and the agent continues.</span>
      </div>
    </section>}

    {done ? <p className="todo-done" role="status">{done}</p> : !calling && <form className="todo-form" onSubmit={(event) => { event.preventDefault(); if (note.trim()) void send("log", { note }) }}>
      <label htmlFor={`todo-${todo.id}`}>Log what happened</label>
      <textarea id={`todo-${todo.id}`} value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={1000}
        placeholder="Who you spoke to and what you agreed" />
      <div className="todo-actions">
        <button type="submit" className="btn primary" disabled={busy || !note.trim()}>{busy ? "Logging…" : "Log it and let the agent continue"}</button>
        <span className="todo-hint">It goes on the order&apos;s timeline in your words; the agent reads it and carries on.</span>
      </div>
    </form>}
    {error && <p className="todo-error" role="alert">{error}</p>}
  </article>
}
