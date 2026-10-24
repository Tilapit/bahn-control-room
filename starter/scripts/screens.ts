// npm run screens -- [--dark] [--both] [--base http://localhost:3001] [--out ../screens] [shot ...]
// Takes full-page screenshots of the running app with Playwright.
// A shot is a path ("/orders/CD-420322"), optionally named ("for-you=/"),
// optionally followed by "+expand" to open the first card before the picture.
// Each shot is saved full-page and as the first screen ("-fold").

import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { chromium } from "playwright"

const DEFAULT_SHOTS = [
  "for-you=/",
  "for-you-open=/+expand",
  "order-CD-420322=/orders/CD-420322",
  "order-CD-420299=/orders/CD-420299",
  "order-CD-420603=/orders/CD-420603",
]

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

async function main() {
  const args = process.argv.slice(2)
  const base = option(args, "--base", process.env.APP_URL ?? "http://localhost:3001")
  const out = resolve(option(args, "--out", join(process.cwd(), "..", "screens")))
  const values = new Set([option(args, "--base", ""), option(args, "--out", "")])
  const shots = args.filter((arg) => !arg.startsWith("--") && !values.has(arg))
  const themes: ("light" | "dark")[] = args.includes("--both") ? ["light", "dark"] : args.includes("--dark") ? ["dark"] : ["light"]
  await mkdir(out, { recursive: true })

  const browser = await chromium.launch()
  try {
    for (const theme of themes) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: theme, deviceScaleFactor: 1 })
      const page = await context.newPage()
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
      for (const shot of shots.length ? shots : DEFAULT_SHOTS) {
        const [nameOrPath, maybePath] = shot.includes("=") ? shot.split("=") : [null, shot]
        const [path, action] = (maybePath ?? "/").split("+")
        const name = nameOrPath ?? (path === "/" ? "home" : path.replace(/^\//, "").replace(/\//g, "-"))
        const response = await page.goto(`${base}${path}`, { waitUntil: "networkidle" })
        if (!response?.ok()) throw new Error(`${path}: HTTP ${response?.status()}`)
        if (action === "expand") {
          await page.locator(".row-head").first().click()
          await page.waitForTimeout(150)
        }
        const file = join(out, `${name}-${theme}.png`)
        await page.screenshot({ path: file, fullPage: true })
        // The first screen, as a person sees it on opening the page.
        await page.screenshot({ path: join(out, `${name}-${theme}-fold.png`), fullPage: false })
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
