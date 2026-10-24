import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { now as clockNow } from "@/lib/clock"
import { learningCases } from "@/lib/settings"
import { When } from "../../ui/when"
import { SettingsNav } from "../settings-nav"

export const metadata: Metadata = { title: "Learning" }

const DESK_ZONE = "Europe/Helsinki"

export default async function Learning() {
  await connection()
  const [cases, at] = await Promise.all([learningCases(), clockNow()])
  const now = at.toISOString()
  return <main className="content narrow">
    <div className="page-head"><div><h1>Settings</h1><p className="page-sub">What agents may do on their own, and what they learn from your corrections.</p></div></div>
    <SettingsNav current="learning" />
    <p className="lead">Every card you rejected or answered with other instructions is kept as a test case: the case file as the agent saw it, what it proposed, and what you did instead. A changed prompt or model is tried against these before it goes live.</p>
    {cases.length === 0 ? <div className="empty"><h2>No corrections yet.</h2><p>When you reject a card or tell the agent to do something else, the case is kept here.</p></div>
      : <ul className="cases">
        {cases.map((item) => <li key={item.id}>
          <div className="case-top">
            {item.reference ? <Link className="link" href={`/orders/${item.reference}`}>{item.reference}</Link> : <span>Test case</span>}
            <span className="faint"><When iso={item.createdAt} now={now} zone={DESK_ZONE} /></span>
          </div>
          <p className="case-line">{item.headline}</p>
          {item.proposed && <p className="sub">Agent proposed: {item.proposed}</p>}
          <p className="sub">
            {item.correction.choice === "reply" ? <>You wrote instead: “{item.correction.reply}”</>
              : item.correction.choice === "reject" ? <>You rejected it{item.correction.reply ? <>: “{item.correction.reply}”</> : "."}</>
              : item.correction.note ?? "Kept as a test case."}
          </p>
          {item.correction.expected && <p className="sub">Expected: {item.correction.expected}</p>}
          <p className="note">{item.lastResult ?? "Not re-run yet."}</p>
        </li>)}
      </ul>}
  </main>
}
