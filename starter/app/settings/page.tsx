import type { Metadata } from "next"

export const metadata: Metadata = { title: "Settings" }

export default function Settings() {
  return <main className="content narrow">
    <div className="page-head"><div><h1>Settings</h1><p className="page-sub">What agents may do on their own, and what they learned from your corrections.</p></div></div>
    <div className="empty">
      <h2>No agent permissions set yet.</h2>
      <p>Until they are, every booking, date change, cost and customer message needs a person&apos;s approval.</p>
    </div>
  </main>
}
