import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"
import { now as clockNow } from "@/lib/clock"
import { ACTION_WORDS, learningSummary, PLAYBOOK_THRESHOLD } from "@/lib/learning"
import { OUTCOME_WORDS, REASON_WORDS, isReason, verdictWords } from "@/lib/reasons"
import { learningCases } from "@/lib/settings"
import { When } from "../../ui/when"
import { SettingsNav } from "../settings-nav"
import { PlaybookActions } from "./playbook-actions"

export const metadata: Metadata = { title: "Learning" }

const DESK_ZONE = "Europe/Helsinki"

type Case = Awaited<ReturnType<typeof learningCases>>[number]

/** A check name from an older run, in today's words. */
const CHECK_WORDS: Record<string, string> = { "A booking tool does not exist": "An agent cannot book anything itself: a booking is made only after a person approves it" }

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
    <p className="case-line">{test ? item.headline.replace(/^Prompt injection test:\s*driver asks/i, "A driver message asks").replace(/^./, (c) => c.toUpperCase()) : item.headline}</p>
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
  const [cases, at, summary] = await Promise.all([learningCases(), clockNow(), learningSummary()])
  const now = at.toISOString()
  const tests = cases.filter((item) => item.correction.choice === "test")
  const corrections = cases.filter((item) => item.correction.choice !== "test")
  return <main className="content narrow">
    <div className="page-head"><div><h1>Settings</h1><p className="page-sub">What agents may do on their own, and what they learn from your corrections.</p></div></div>
    <SettingsNav current="learning" />
    <p className="lead">Agents learn from your decisions without being retrained: they look up similar past decisions before they propose, rules you approve are added to their instructions, and how often you approve a kind of action unchanged decides when the agent may do it without asking.</p>

    <section className="permission-group">
      <h2 className="section-title">Playbook rules</h2>
      <p className="note">When {PLAYBOOK_THRESHOLD} or more rejections or changes share one reason for one kind of action, code drafts a rule and Haiku words it. Approving runs the recorded evals first; only if they pass is the rule added to the Investigator&apos;s instructions.</p>
      {summary.rules.length === 0 ? <p className="note">No suggestions yet.</p> : <ul className="cases">{summary.rules.map((rule) => <li key={rule.id}>
        <div className="case-top"><b>{ACTION_WORDS[rule.action] ? ACTION_WORDS[rule.action].replace(/^./, (c) => c.toUpperCase()) : rule.action}</b>
          <span className="faint">{rule.basedOn.length} times “{isReason(rule.reason) ? REASON_WORDS[rule.reason] : rule.reason}” · worded by {rule.wordedBy === "Haiku" ? "Haiku" : "code (no model available)"}</span></div>
        <p className="case-line">{rule.text}</p>
        {rule.status === "suggested" ? <PlaybookActions id={rule.id} />
          : <p className="sub">{rule.status === "approved" ? "Approved: the Investigator follows it." : "Dismissed."}</p>}
        {rule.evalResult && <p className="note">Evals before approval: {rule.evalPassed ? "passed" : "did not pass"} ({rule.evalResult})</p>}
      </li>)}</ul>}
    </section>

    <section className="permission-group">
      <h2 className="section-title">Approved unchanged, by kind of action</h2>
      <p className="note">Here: decisions in this control room (the numbers the autonomy suggestion uses). Before: the dataset&apos;s own reviews{summary.past.some((row) => row.origin === "seeded") ? " and the demo history" : ""}.</p>
      <table className="learning-table">
        <thead><tr><th>Action</th><th>Here</th><th>Before: approved · changed · rejected</th></tr></thead>
        <tbody>{summary.rates.map((rate) => <tr key={rate.action}>
          <td>{ACTION_WORDS[rate.action] ? ACTION_WORDS[rate.action].replace(/^./, (c) => c.toUpperCase()) : rate.action}</td>
          <td className="num">{rate.decided ? `${rate.approvedUnchanged} of ${rate.decided} (${Math.round((rate.rate ?? 0) * 100)}%)` : <span className="faint">none yet</span>}</td>
          <td className="num">{rate.earlier.approved} · {rate.earlier.changed} · {rate.earlier.rejected}</td>
        </tr>)}</tbody>
      </table>
    </section>

    <section className="permission-group">
      <h2 className="section-title">Why proposals were rejected or changed</h2>
      {summary.reasons.length === 0 ? <p className="note">No reasons yet.</p>
        : <p className="learning-reasons">{summary.reasons.map(([reason, n]) => <span key={reason}><b>{isReason(reason) ? REASON_WORDS[reason] : reason}</b> {n}</span>)}</p>}
    </section>

    <section className="permission-group">
      <h2 className="section-title">Outcomes, checked in code after the deadline</h2>
      <p className="note">Worked {summary.outcomes.worked} · Partly {summary.outcomes.partly} · Didn&apos;t work {summary.outcomes.didnt_work} · not checked yet or nothing carried out {summary.outcomes.unchecked}</p>
      <ul className="cases">{summary.past.slice(0, 12).map((row) => <li key={row.id}>
        <div className="case-top">
          {row.reference ? <Link className="link" href={`/orders/${row.reference}`}>{row.reference}</Link> : <span>An order</span>}
          <span className="faint"><When iso={row.decidedAt.toISOString()} now={now} zone={DESK_ZONE} as="day" /> · {row.origin === "live" ? "here" : row.origin === "dataset" ? "dataset review" : "demo history"}</span>
        </div>
        <p className="case-line">{row.proposal}: {verdictWords(row)}{row.reasonText ? ` (“${row.reasonText}”)` : ""}</p>
        <p className="sub">{row.outcome ? <><b className={`outcome ${row.outcome}`}>{OUTCOME_WORDS[row.outcome]}</b>: {row.outcomeNote}</> : row.outcomeNote ?? "Not checked yet"}</p>
      </li>)}</ul>
    </section>

    <p className="lead">When you reject a proposal or tell the agent to do something else, the case is also kept below: what the agent saw, what it proposed and what you did instead. When the agents are changed, they can be tested again against these cases.</p>
    <section className="permission-group">
      <h2 className="section-title">Your corrections</h2>
      {corrections.length === 0 ? <p className="note">None yet. When you reject a proposal or tell the agent to do something else, it is kept here.</p>
        : <ul className="cases">{corrections.map((item) => <Entry key={item.id} item={item} now={now} test={false} />)}</ul>}
    </section>
    {tests.length > 0 && <section className="permission-group">
      <h2 className="section-title">Tests against tricks</h2>
      <p className="note">Messages written to trick an agent into breaking its rules, kept so the agents can be tested against them again. The orders and people are fictional.</p>
      <ul className="cases">{tests.map((item) => <Entry key={item.id} item={item} now={now} test />)}</ul>
    </section>}
  </main>
}
