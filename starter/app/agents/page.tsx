import type { Metadata } from "next"

export const metadata: Metadata = { title: "Agents" }

export default function Agents() {
  return <main className="content narrow">
    <div className="page-head"><div><h1>Agents</h1><p className="page-sub">What the agents are doing right now.</p></div></div>
    <div className="empty">
      <h2>No agent has run yet.</h2>
      <p>When agents look into an order, each run shows here: the order, what the agent is doing, and when it checks again.</p>
    </div>
  </main>
}
