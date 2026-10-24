// npm run scenario -- 1 [--base http://localhost:3001]
// Plays a demo scenario (SPEC 9) in the browser with Playwright and takes a
// screenshot of every step into ../screens/scenario-<n>/. The agent work behind a
// scenario must already exist (scenario 1: run `npm run agents:investigate -- CD-420299 --fresh`).

import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { chromium, type Page } from "playwright"

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

type Shot = (name: string, page?: Page) => Promise<void>

async function scenario1(page: Page, base: string, shot: Shot) {
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
  await page.waitForTimeout(1200)
  await shot("03-approved-undo-window")
  await page.locator(".toast button", { hasText: "Undo" }).click()
  await page.waitForTimeout(800)
  await shot("04-undone-card-back")
  const again = page.locator("article.row", { hasText: "BMW M4" }).filter({ hasText: "ferry" }).first()
  if (await again.getAttribute("data-open") !== "true") await again.locator(".row-head").click()
  await again.locator(".row-actions .btn.primary").first().click()
  await page.locator(".toast").waitFor()
  await page.waitForTimeout(9500)
  await shot("05-carried-out")
  await page.goto(`${base}/orders/CD-420299`, { waitUntil: "networkidle" })
  await shot("06-order-booked")
}

const SCENARIOS: Record<string, (page: Page, base: string, shot: Shot) => Promise<void>> = { "1": scenario1 }

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

main().catch((error) => { console.error(error); process.exitCode = 1 })
