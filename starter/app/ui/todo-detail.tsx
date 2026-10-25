"use client"

import { useState } from "react"
import type { Todo } from "@/lib/todos"
import "./todo.css"

/**
 * "To do: call <contact>": a call the person approved and makes themselves. It stays until they log what happened;
 * the log goes on the order's timeline, the Classifier reads it, and the agent continues with it.
 */
export function TodoDetail({ todo, onDone }: { todo: Todo; onDone: () => void }) {
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function log() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/todos/${encodeURIComponent(todo.id)}/log`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }),
      })
      const result = await response.json().catch(() => ({})) as { ok?: boolean; message?: string; error?: string }
      if (!response.ok || !result.ok) throw new Error(result.error ?? "The log was not saved.")
      setDone(result.message ?? "Logged.")
      onDone()
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
    {done ? <p className="todo-done" role="status">{done}</p> : <form className="todo-form" onSubmit={(event) => { event.preventDefault(); if (note.trim()) void log() }}>
      <label htmlFor={`todo-${todo.id}`}>Log what happened</label>
      <textarea id={`todo-${todo.id}`} value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={1000}
        placeholder="Who you spoke to and what you agreed" />
      <div className="todo-actions">
        <button type="submit" className="btn primary" disabled={busy || !note.trim()}>{busy ? "Logging…" : "Log it and let the agent continue"}</button>
        <span className="todo-hint">It goes on the order&apos;s timeline in your words; the agent reads it and carries on.</span>
      </div>
      {error && <p className="todo-error" role="alert">{error}</p>}
    </form>}
  </article>
}
