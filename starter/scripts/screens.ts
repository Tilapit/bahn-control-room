// npm run screens -- [--dark] [--both] [--slices 6] [--height 900] [--width 390] [--base http://localhost:3001] [--out ../screens] [shot ...]
// Takes full-page screenshots of the running app with Playwright.
// A shot is a path ("/orders/CD-420322"), optionally named ("for-you=/"),
// optionally followed by an action: "+expand" opens the first card, "+search" types a search,
// "+keys" presses J twice on For you, "+reply" presses R, "+view-Finland" saves that team view and reloads, "+ask" asks the agents a question (live, with an API key), "+approve" approves the first agent
// card, takes the picture during the undo window and then presses Undo, so nothing is carried out.
// Each shot is saved full-page and as the first screen ("-fold"). With --slices N, also as up to N
// screens scrolled one after another ("-1", "-2", …): what a person sees, readable at full size.

import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { chromium } from "playwright"

const DEFAULT_SHOTS = [
  "for-you=/",
  "for-you-open=/+expand",
  "agents=/agents",
  "agents-done=/agents?show=done",
  "agents-quiet=/agents?show=quiet",
  "orders=/orders",
  "order-CD-420322=/orders/CD-420322",
  "order-CD-420299=/orders/CD-420299",
  "order-CD-420603=/orders/CD-420603",
  "order-CD-420123=/orders/CD-420123",
  "run=/agents/run_cb4623d2",
  "how-it-works=/settings/how-it-works", "orders-filter=/orders?q=Hamburg",
  "settings=/settings",
  "learning=/settings/learning",
  "demo=/demo",
  "search=/+search",
  "not-found=/orders/CD-999999",
]

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

async function main() {
  const args = process.argv.slice(2)
  const base = option(args, "--base", process.env.APP_URL ?? "http://localhost:3001")
  const out = resolve(option(args, "--out", join(process.cwd(), "..", "screens")))
  const slices = Number(option(args, "--slices", "0")) || 0
  const values = new Set([option(args, "--base", ""), option(args, "--out", ""), option(args, "--slices", ""), option(args, "--height", ""), option(args, "--width", "")])
  const shots = args.filter((arg) => !arg.startsWith("--") && !values.has(arg))
  const themes: ("light" | "dark")[] = args.includes("--both") ? ["light", "dark"] : args.includes("--dark") ? ["dark"] : ["light"]
  await mkdir(out, { recursive: true })

  const browser = await chromium.launch()
  try {
    for (const theme of themes) {
      const context = await browser.newContext({ viewport: { width: Number(option(args, "--width", "1440")) || 1440, height: Number(option(args, "--height", "960")) || 960 }, colorScheme: theme, deviceScaleFactor: 1 })
      const page = await context.newPage()
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
      for (const shot of shots.length ? shots : DEFAULT_SHOTS) {
        // Only the first "=" names the shot; a query string keeps its own ("/agents?show=done").
        const cut = shot.indexOf("=")
        const [nameOrPath, maybePath] = cut > 0 && !shot.slice(0, cut).includes("/") ? [shot.slice(0, cut), shot.slice(cut + 1)] : [null, shot]
        const [path, action] = (maybePath ?? "/").split("+")
        const name = nameOrPath ?? (path === "/" ? "home" : path.replace(/^\//, "").replace(/\//g, "-"))
        const response = await page.goto(`${base}${path}`, { waitUntil: "networkidle" })
        if (!response?.ok() && name !== "not-found") throw new Error(`${path}: HTTP ${response?.status()}`)
        if (action === "search") {
          await page.locator(".search-box input").fill("Hamburg ferry")
          await page.waitForTimeout(600)
        }
        if (action === "expand") {
          // For you is an inbox: a click on a row selects it (and opens it full width on a narrow screen).
          await page.locator(".inbox-row button").first().click()
          await page.waitForTimeout(150)
        }
        if (action?.startsWith("view-")) {
          // "+view-Finland" or "+view-Finland-through": the team view a person saved, then the page again.
          const [, market, through] = action.split("-")
          await page.evaluate((view) => localStorage.setItem("bahn.teamView.v1", JSON.stringify(view)), { market, desks: [], passingThrough: through === "through" })
          await page.reload({ waitUntil: "networkidle" })
        }
        if (action === "reply") {
          // R opens the reply box under the selected case's buttons.
          await page.keyboard.press("r")
          await page.waitForTimeout(200)
        }
        if (action === "keys") {
          // J twice: the selection moves down the list and the detail follows.
          await page.keyboard.press("j")
          await page.keyboard.press("j")
          await page.waitForTimeout(200)
        }
        if (action === "ask") {
          await page.locator(".search-box input").fill("Why is CD-420603 at risk?")
          await page.locator(".search-box input").press("Enter")
          await page.locator(".ask-answer, .search-empty").first().waitFor({ timeout: 120_000 })
        }
        const file = join(out, `${name}-${theme}.png`)
        if (action === "approve") {
          // Inside the 8-second undo window: one picture of the first screen, then Undo, so nothing is carried out.
          await page.locator(".case-detail .row-actions .btn.primary").first().click()
          await page.locator(".toast").waitFor()
          await page.waitForTimeout(1200)
          await page.screenshot({ path: file, fullPage: false })
          await page.locator(".toast button", { hasText: "Undo" }).click()
          await page.waitForTimeout(800)
          console.log(file)
          continue
        }
        await page.screenshot({ path: file, fullPage: true })
        // The first screen, as a person sees it on opening the page.
        await page.screenshot({ path: join(out, `${name}-${theme}-fold.png`), fullPage: false })
        if (slices) {
          const height = await page.evaluate(() => document.documentElement.scrollHeight)
          const step = 960 - 120
          for (let index = 0; index < slices && index * step < height - 120; index += 1) {
            await page.evaluate((y) => window.scrollTo(0, y), index * step)
            await page.waitForTimeout(120)
            await page.screenshot({ path: join(out, `${name}-${theme}-${index + 1}.png`), fullPage: false })
          }
          await page.evaluate(() => window.scrollTo(0, 0))
        }
        console.log(`${file}${errors.length ? `  (browser errors: ${errors.join(" | ")})` : ""}`)
        errors.length = 0
      }
      await context.close()
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
