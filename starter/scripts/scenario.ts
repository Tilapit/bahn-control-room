// npm run scenario -- 1 [--base http://localhost:3001]
// Plays a demo scenario (SPEC 9) in the browser with Playwright and takes a
// screenshot of every step into ../screens/scenario-<n>/. The agent work behind a
// scenario must already exist (scenario 1: run `npm run agents:investigate -- CD-420299 --fresh`).

import "dotenv/config"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { chromium, type Page } from "playwright"

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

type Shot = (name: string, page?: Page) => Promise<void>

async function scenario1(page: Page, base: string, shot: Shot) {
  // Replayable: forget earlier decisions on CD-420299 (the agent's card and work stay).
  const { getCase } = await import("@/lib/case")
  const { resetOrderDecisions } = await import("@/lib/agents/reset")
  const file = await getCase("CD-420299")
  if (file) await resetOrderDecisions(file.order.id)
  await page.goto(`${base}/`, { waitUntil: "networkidle" })
  await shot("01-for-you")
  const row = page.locator("article.row", { hasText: "BMW M4" }).filter({ hasText: "ferry" }).first()
  await row.locator(".row-head").click()
  await page.waitForTimeout(200)
  await row.scrollIntoViewIfNeeded()
  await shot("02-card-open")
  const approve = row.locator(".row-actions .btn.primary").first()
  const label = await approve.innerText()
  console.log(`  approving: ${label}`)
  await approve.click()
  await page.locator(".toast").waitFor()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(1200)
  await shot("03-approved-undo-window")
  await page.locator(".toast button", { hasText: "Undo" }).click()
  await page.waitForTimeout(800)
  const again = page.locator("article.row", { hasText: "BMW M4" }).filter({ hasText: "ferry" }).first()
  await again.scrollIntoViewIfNeeded()
  await shot("04-undone-card-back")
  if (await again.getAttribute("data-open") !== "true") await again.locator(".row-head").click()
  await again.locator(".row-actions .btn.primary").first().click()
  await page.locator(".toast").waitFor()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(9500)
  await shot("05-carried-out")
  await page.goto(`${base}/orders/CD-420299`, { waitUntil: "networkidle" })
  await shot("06-order-booked")
}

/** The newest Investigator run on an order, from the database. */
async function latestRun(reference: string) {
  const { db } = await import("@/lib/db")
  const { agentRuns, orders } = await import("@/lib/schema")
  const { and, desc, eq } = await import("drizzle-orm")
  const [row] = await db.select({ id: agentRuns.id, status: agentRuns.status, startedAt: agentRuns.startedAt }).from(agentRuns)
    .innerJoin(orders, eq(orders.id, agentRuns.orderId))
    .where(and(eq(orders.reference, reference), eq(agentRuns.agent, "Investigator"))).orderBy(desc(agentRuns.startedAt), desc(agentRuns.id)).limit(1)
  return row ?? null
}

async function waitFor(check: () => Promise<boolean>, seconds: number, what: string) {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

async function scenario2(page: Page, base: string, shot: Shot) {
  await page.goto(`${base}/demo`, { waitUntil: "networkidle" })
  await shot("01-demo-controls")
  await page.locator(".demo-events li", { hasText: "Scenario 2" }).locator("button").click()
  await page.locator(".bubble.mine", { hasText: "red warning came back" }).waitFor({ timeout: 30_000 })
  await page.locator(".demo-grid").scrollIntoViewIfNeeded()
  await page.waitForTimeout(1500)
  await shot("02-driver-message-injected")
  // The Investigator (Opus, safety) asks the driver; the simulated driver answers.
  await page.locator(".bubble", { hasText: "" }).filter({ hasText: "Investigator agent" }).first().waitFor({ timeout: 180_000 })
  await page.locator(".demo-grid").scrollIntoViewIfNeeded()
  await page.waitForTimeout(2500)
  await shot("03-agent-asks-driver")
  await waitFor(async () => (await latestRun("CD-420322"))?.status === "waiting_person", 300, "the Investigator's card")
  await page.goto(`${base}/demo`, { waitUntil: "networkidle" })
  await page.locator(".demo-grid").scrollIntoViewIfNeeded()
  await page.waitForTimeout(2500)
  await shot("04-simulated-driver-answered")
  await page.goto(`${base}/`, { waitUntil: "networkidle" })
  await shot("05-for-you-card")
  const row = page.locator("article.row", { hasText: "Bentley Continental GT" }).first()
  await row.locator(".row-head").click()
  await page.waitForTimeout(300)
  await shot("06-card-open")
  await page.screenshot({ path: join(process.cwd(), "..", "screens", "scenario-2", "06-card-open-full.png"), fullPage: true })
  const firstRun = await latestRun("CD-420322")
  await row.locator(".row-reply input").fill("call the seller first")
  await shot("07-reply-typed")
  await row.locator(".row-reply button", { hasText: "Send to agent" }).click()
  await page.locator(".toast").waitFor()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(1000)
  await shot("08-reply-undo-window")
  // After the window the same run continues with the reply and brings a new card.
  await waitFor(async () => {
    const { db } = await import("@/lib/db")
    const { cards } = await import("@/lib/schema")
    const { and, eq } = await import("drizzle-orm")
    const open = await db.select({ id: cards.id }).from(cards).where(and(eq(cards.runId, firstRun!.id), eq(cards.status, "open")))
    return open.length > 0 && (await latestRun("CD-420322"))?.status === "waiting_person"
  }, 300, "the agent's next card")
  await page.goto(`${base}/`, { waitUntil: "networkidle" })
  const next = page.locator("article.row", { hasText: "Bentley Continental GT" }).first()
  await next.locator(".row-head").click()
  await page.waitForTimeout(300)
  await shot("09-agent-continued")
  await page.screenshot({ path: join(process.cwd(), "..", "screens", "scenario-2", "09-agent-continued-full.png"), fullPage: true })
  await page.goto(`${base}/orders/CD-420322`, { waitUntil: "networkidle" })
  await shot("10-order-timeline")
}

const SCENARIOS: Record<string, (page: Page, base: string, shot: Shot) => Promise<void>> = { "1": scenario1, "2": scenario2 }

async function main() {
  const args = process.argv.slice(2)
  const which = args.find((arg) => SCENARIOS[arg])
  if (!which) throw new Error(`Usage: npm run scenario -- <${Object.keys(SCENARIOS).join("|")}>`)
  const base = option(args, "--base", process.env.APP_URL ?? "http://localhost:3001")
  const out = resolve(join(process.cwd(), "..", "screens", `scenario-${which}`))
  await mkdir(out, { recursive: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "light" })
  const page = await context.newPage()
  page.on("pageerror", (error) => console.log(`  browser error: ${error.message}`))
  const shot: Shot = async (name, target = page) => {
    const file = join(out, `${name}.png`)
    await target.screenshot({ path: file, fullPage: false })
    console.log(file)
  }
  try {
    await SCENARIOS[which](page, base, shot)
  } finally {
    await browser.close()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(async () => (await import("@/lib/db")).closeDb())
