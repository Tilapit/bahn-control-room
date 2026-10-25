// npm run check:loop -- [--out <dir>]
// Proves the operator loop end to end in a real browser, from `npm run demo:reset`, against the running app (APP_URL or
// :3001). Not footage: it reports each step PASS / FAIL with a screenshot.
//  A. CD-420322: replay the red warning light → Agents shows the Investigator, then not working → For you card →
//     Approve → Mine "To do: call Marvellin Motorhandel" → log what happened → the agent's next card → Approve →
//     the order's timeline.
//  B. CD-420299: open the ferry card → Approve → after the undo window the ferry is booked on the order.

import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { chromium, type Page } from "playwright"

const args = process.argv.slice(2)
const base = process.env.APP_URL ?? "http://localhost:3001"
const out = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : join(process.cwd(), "..", "screens", "loop"))
const LOG = "Dealer sends their own roadside assistance, arriving 14:30; they accept late delivery."
const results: { step: string; ok: boolean; note: string }[] = []
let shot = 0

async function step(page: Page, name: string, run: () => Promise<string | void>): Promise<boolean> {
  let ok = true
  let note = ""
  try { note = (await run()) ?? "" } catch (error) { ok = false; note = error instanceof Error ? error.message.split("\n")[0] : String(error) }
  shot += 1
  const file = join(out, `${String(shot).padStart(2, "0")}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50)}.png`)
  await page.screenshot({ path: file, fullPage: false }).catch(() => undefined)
  results.push({ step: name, ok, note })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}  [${file}]`)
  return ok
}

/** Reload a page until a test passes, for work the agents do in the background. */
async function until(page: Page, path: string, test: () => Promise<boolean>, seconds: number): Promise<boolean> {
  const end = Date.now() + seconds * 1000
  while (Date.now() < end) {
    await page.goto(`${base}${path}`, { waitUntil: "networkidle" })
    if (await test()) return true
    await page.waitForTimeout(5000)
  }
  return false
}

const card = (page: Page, reference: string) => page.locator(".inbox-row", { hasText: reference }).first()

async function approveOpen(page: Page, reference: string): Promise<string> {
  const later = page.locator(".later-toggle")
  if (!(await card(page, reference).count()) && await later.count()) await later.click()
  await card(page, reference).locator("button").click()
  const button = page.locator(".case-detail .row-actions .btn.primary").first()
  if (!(await button.count())) throw new Error("the card has no approve button (a question or a code-built card)")
  const label = (await button.textContent())?.replace(/\s*A$/, "").trim() ?? ""
  await button.click()
  await page.locator(".toast").waitFor({ timeout: 10_000 })
  await page.waitForTimeout(10_500)
  return label
}

async function main() {
  await mkdir(out, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    // ---- A. CD-420322 -------------------------------------------------------------------------------------------
    await step(page, "Demo controls: replay the red warning light", async () => {
      await page.goto(`${base}/demo`, { waitUntil: "networkidle" })
      await page.locator(".demo-events li", { hasText: "Scenario 2" }).locator("button", { hasText: "Replay" }).click()
      await page.locator(".replay-status").waitFor({ timeout: 15_000 })
      return (await page.locator(".replay-status").textContent())?.trim()
    })
    await step(page, "Agents shows the Investigator working on CD-420322", async () => {
      const row = page.locator(".run-row", { hasText: "CD-420322" }).filter({ hasText: "Investigator" }).first()
      const seen = await until(page, "/agents", async () => await row.count() > 0 && /Working|Waiting for driver/.test(await row.textContent() ?? ""), 180)
      if (!seen) throw new Error("no working Investigator row for CD-420322 within 3 min")
      return (await row.textContent())?.replace(/\s+/g, " ").slice(0, 120)
    })
    let firstCard: string | null = null
    await step(page, "The replay ends: the Investigator is done and For you shows its card", async () => {
      // The replay plays the recorded run at its real speed (about 3.5 min); its card is written at the end.
      const done = await until(page, "/demo", async () => await page.locator(".replay-status").count() === 0, 420)
      if (!done) throw new Error("the replay was still playing after 7 min")
      await page.goto(`${base}/agents`, { waitUntil: "networkidle" })
      const working = await page.locator(".run-row", { hasText: "CD-420322" }).filter({ hasText: /Working|Waiting for driver/ }).count()
      if (working) throw new Error("the Investigator still shows as working")
      await page.goto(`${base}/`, { waitUntil: "networkidle" })
      if (!(await card(page, "CD-420322").count())) throw new Error("no card for CD-420322 on For you")
      firstCard = await card(page, "CD-420322").getAttribute("data-card")
      return (await card(page, "CD-420322").textContent())?.replace(/\s+/g, " ").slice(0, 100)
    })
    await step(page, "Approve the card", async () => `pressed "${await approveOpen(page, "CD-420322")}"`)
    await step(page, "Mine shows the to-do", async () => {
      await page.goto(`${base}/`, { waitUntil: "networkidle" })
      await page.locator(".fy-tabs button", { hasText: "Mine" }).click()
      const todo = page.locator(".todo-row", { hasText: "To do: call Marvellin Motorhandel" })
      await todo.waitFor({ timeout: 10_000 })
      await todo.locator("button").click()
      return "To do: call Marvellin Motorhandel"
    })
    await step(page, "Log what happened", async () => {
      await page.locator("article.todo textarea").fill(LOG)
      await page.locator("article.todo button", { hasText: "Log it" }).click()
      await page.locator(".todo-done").waitFor({ timeout: 120_000 })
      return (await page.locator(".todo-done").textContent())?.trim()
    })
    let nextCard = false
    await step(page, "The agent resumes and proposes the next card", async () => {
      // A new card: an open card on the order that is not the one approved before.
      nextCard = await until(page, "/", async () => await card(page, "CD-420322").count() > 0 && await card(page, "CD-420322").getAttribute("data-card") !== firstCard, 480)
      if (!nextCard) throw new Error("no new card for CD-420322 within 8 min")
      await card(page, "CD-420322").locator("button").click()
      await page.waitForTimeout(800)
      return (await page.locator(".case-detail .cd-head h2").textContent())?.trim()
    })
    if (nextCard) await step(page, "Approve the next card", async () => `pressed "${await approveOpen(page, "CD-420322")}"`)
    await step(page, "The order's timeline shows every step with its source", async () => {
      await page.goto(`${base}/orders/CD-420322`, { waitUntil: "networkidle" })
      const timeline = page.locator("section[aria-label='Timeline']")
      await timeline.scrollIntoViewIfNeeded()
      const text = (await timeline.textContent()) ?? ""
      const missing = [["the driver's warning-light message", /warning light/i], ["the call log in the person's words", /they accept late delivery/i], ["a decision by Ops", /Ops/], ["the agent", /Investigator|agent/i]]
        .filter(([, pattern]) => !(pattern as RegExp).test(text)).map(([name]) => name)
      if (missing.length) throw new Error(`timeline lacks: ${missing.join(", ")}`)
      return "warning light, call log, Ops decisions and agent steps all on the timeline"
    })

    // ---- B. CD-420299 -------------------------------------------------------------------------------------------
    await step(page, "Ferry card: approve", async () => {
      await page.goto(`${base}/`, { waitUntil: "networkidle" })
      return `pressed "${await approveOpen(page, "CD-420299")}"`
    })
    await step(page, "The ferry is booked on the order", async () => {
      await page.goto(`${base}/orders/CD-420299`, { waitUntil: "networkidle" })
      const travel = (await page.locator("section[aria-label='Route and travel']").textContent()) ?? ""
      if (!/Booked[\s\S]*Ferry/i.test(travel)) throw new Error("no booked ferry under Route and travel")
      const timeline = (await page.locator("section[aria-label='Timeline']").textContent()) ?? ""
      if (!/book/i.test(timeline)) throw new Error("no booking on the timeline")
      await page.locator("section[aria-label='Route and travel']").scrollIntoViewIfNeeded()
      return "Booked ferry under Route and travel, and on the timeline"
    })
  } finally {
    await browser.close()
  }
  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length} of ${results.length} steps passed.`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
