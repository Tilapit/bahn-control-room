import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { now as clockNow } from "@/lib/clock"
import { learningCases } from "@/lib/settings"
import { When } from "../../ui/when"
import { SettingsNav } from "../settings-nav"

export const metadata: Metadata = { title: "Learning" }

const DESK_ZONE = "Europe/Helsinki"

type Case = Awaited<ReturnType<typeof learningCases>>[number]

/** A check name from an older run, in today's words. */
const CHECK_WORDS: Record<string, string> = { "A booking tool does not exist": "Agents have no tool that books anything" }

/** "Passed (10 of 10 checks): ✓ a; ✓ b" → the verdict and one line per check. */
function result(text: string | null): { verdict: string; checks: { ok: boolean; name: string }[] } | null {
  if (!text) return null
  const match = text.match(/^([^:]+):\s*([\s\S]*)$/)
  if (!match) return { verdict: text, checks: [] }
  const checks = match[2].split(/;\s*(?=[✓✗])/).map((part) => ({ ok: part.trim().startsWith("✓"), name: part.replace(/^[✓✗]\s*/, "").trim() }))
    .map((check) => ({ ...check, name: CHECK_WORDS[check.name] ?? check.name }))
  return { verdict: match[1].replace(/\((\d+) of (\d+) checks\)/, "$1 of $2 checks"), checks }
}

function Entry({ item, now, test }: { item: Case; now: string; test: boolean }) {
  const outcome = result(item.lastResult)
  return <li>
    <div className="case-top">
      {item.reference ? <Link className="link" href={`/orders/${item.reference}`}>{item.reference}</Link> : <span>Test case</span>}
      <span className="faint"><When iso={item.createdAt} now={now} zone={DESK_ZONE} as="day" /></span>
    </div>
    <p className="case-line">{test ? item.headline.replace(/^Prompt injection test:\s*/i, "A planted driver message: ").replace(/^./, (c) => c.toUpperCase()) : item.headline}</p>
    {item.proposed && <p className="sub">The agent proposed: {item.proposed.replace(/^approve:\s*/i, "")}</p>}
    {!test && <p className="sub">
      {item.correction.choice === "reply" ? <>You wrote instead: “{item.correction.reply}”</>
        : item.correction.choice === "reject" ? <>You rejected it{item.correction.reply ? <>: “{item.correction.reply}”</> : "."}</>
        : item.correction.note ?? "Kept as a test case."}
    </p>}
    {item.correction.expected && <p className="sub">Expected: {item.correction.expected.replace(/ as a card\b/, " as a proposal")}</p>}
    {outcome ? <div className="note">
      <p>{outcome.verdict}</p>
      {outcome.checks.length > 0 && <ul className="checks">{outcome.checks.map((check) => <li key={check.name} className={check.ok ? "ok" : "failed"}>{check.ok ? "✓" : "✗"} {check.name}</li>)}</ul>}
    </div> : <p className="note">Not run again yet.</p>}
  </li>
}

export default async function Learning() {
  await connection()
  const [cases, at] = await Promise.all([learningCases(), clockNow()])
  const now = at.toISOString()
  const tests = cases.filter((item) => item.correction.choice === "test")
  const corrections = cases.filter((item) => item.correction.choice !== "test")
  return <main className="content narrow">
    <div className="page-head"><div><h1>Settings</h1><p className="page-sub">What agents may do on their own, and what they learn from your corrections.</p></div></div>
    <SettingsNav current="learning" />
    <p className="lead">When you reject a proposal or tell the agent to do something else, the case is kept here: what the agent saw, what it proposed and what you did instead. A changed prompt or model can then be checked against these cases.</p>
    <section className="permission-group">
      <h2 className="section-title">Your corrections</h2>
      {corrections.length === 0 ? <p className="note">None yet. When you reject a proposal or tell the agent to do something else, it is kept here.</p>
        : <ul className="cases">{corrections.map((item) => <Entry key={item.id} item={item} now={now} test={false} />)}</ul>}
    </section>
    {tests.length > 0 && <section className="permission-group">
      <h2 className="section-title">Safety tests</h2>
      <p className="note">Messages written to trick an agent, kept so a changed prompt or model can be checked against them. The orders and people are fictional.</p>
      <ul className="cases">{tests.map((item) => <Entry key={item.id} item={item} now={now} test />)}</ul>
    </section>}
  </main>
}
