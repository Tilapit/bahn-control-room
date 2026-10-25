// Takes the light-theme screenshots for the video and records the box of every element we highlight.
// Read-only: it only navigates, clicks rows and scrolls. Run: node scripts/shots.mts
import { chromium, type Page } from "/Users/jannelappi/Projects/bahn-control-room/starter/node_modules/playwright/index.mjs"
import { writeFileSync, readFileSync, existsSync } from "node:fs"

const base = "http://localhost:3001"
const dir = new URL("../public/shots/", import.meta.url).pathname
type Box = { x: number; y: number; width: number; height: number }
const boxes: Record<string, Record<string, Box | null>> = existsSync(dir + "boxes.json") ? JSON.parse(readFileSync(dir + "boxes.json", "utf8")) : {}
const only = process.argv.slice(2)

// Innermost element whose text matches, then `climb` parents up (or up to the first ancestor matching `until`).
async function find(page: Page, source: string, flags = "i", climb = 0, until = ""): Promise<Box | null> {
  return page.evaluate(({ source, flags, climb, until }) => {
    const re = new RegExp(source, flags)
    const all = Array.from(document.body.querySelectorAll("*")).filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && re.test((el as HTMLElement).innerText ?? el.textContent ?? "")
    })
    const inner = all.filter((el) => !all.some((o) => o !== el && el.contains(o)))
    // Prefer one that is on screen.
    let el = inner.find((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight }) ?? inner[0]
    if (!el) return null
    if (until) { const a = el.closest(until); if (a) el = a }
    for (let i = 0; i < climb && el.parentElement; i++) el = el.parentElement
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
  }, { source, flags, climb, until })
}

async function scrollTo(page: Page, source: string) {
  await page.evaluate((source) => {
    const re = new RegExp(source, "i")
    const all = Array.from(document.body.querySelectorAll("h1,h2,h3,h4,p,div,span,summary,button")).filter((el) => re.test((el as HTMLElement).innerText ?? ""))
    const inner = all.filter((el) => !all.some((o) => o !== el && el.contains(o)))
    inner[0]?.scrollIntoView({ block: "start" })
  }, source)
  await page.waitForTimeout(500)
}

async function ready(page: Page, path: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(base + path, { waitUntil: "networkidle" })
    await page.waitForTimeout(800)
    const styled = await page.evaluate(() => {
      const nav = document.querySelector("nav, aside")
      return !!nav && nav.getBoundingClientRect().width > 120 && getComputedStyle(document.body).fontFamily !== "" && document.styleSheets.length > 0
    })
    if (styled) return
    console.log(`${path}: not styled yet, waiting 10 s`)
    await page.waitForTimeout(10_000)
  }
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" })
await context.addInitScript(() => { try { localStorage.setItem("bahn.theme", "light") } catch {} })
const page = await context.newPage()

async function shot(name: string, setup: () => Promise<void>, targets: Record<string, () => Promise<Box | null>>) {
  if (only.length && !only.includes(name)) return
  await setup()
  boxes[name] = {}
  for (const [key, get] of Object.entries(targets)) boxes[name][key] = await get()
  await page.screenshot({ path: `${dir}${name}.png` })
  console.log(name, JSON.stringify(boxes[name]))
}

await shot("foryou", async () => {
  await ready(page, "/")
  await page.locator(".inbox-row", { hasText: "CD-420322" }).first().locator("button").first().click().catch(() => {})
  await page.waitForTimeout(600)
}, {
  title: () => find(page, "^\\s*\\d+ orders? need you now\\s*$"),
  tabs: () => find(page, "^\\s*Unclaimed\\s*\\d+\\s*$", "i", 1),
  mikko: () => find(page, "Mikko P\\. · no activity", "i", 0, ".inbox-row"),
  bentley: () => find(page, "Bentley Continental GT · Munich", "i", 0, ".inbox-row"),
})

await shot("case-facts", async () => { await ready(page, "/orders/CD-420322"); await scrollTo(page, "^What we know") }, {
  chip1: () => page.evaluate(() => null),
  checked: () => find(page, "^Each fact was checked against its source"),
  quotes: () => find(page, "\\(quotes, not booked\\)"),
})

await shot("case-approve", async () => { await ready(page, "/orders/CD-420322"); await scrollTo(page, "^What the agent already did") }, {
  checklist: () => find(page, "^What the agent already did", "i", 1),
  suggests: () => find(page, "^Agent suggests$", "i", 1),
  ifApprove: () => find(page, "^If you approve$", "i", 1),
  approve: () => find(page, "^\\s*Approve", "i", 0, "button"),
})

await shot("trace", async () => {
  await ready(page, "/orders/CD-420322")
  const href = await page.locator("a", { hasText: "See every step the agent took" }).first().getAttribute("href")
  await ready(page, href ?? "/agents/run_0e064073")
  writeFileSync(dir + "../../scripts/.trace.txt", await page.innerText("body"))
}, {})

await shot("agents", async () => { await ready(page, "/agents") }, {
  summary: () => find(page, "^Today agents worked on"),
  watching: () => find(page, "^Watching · \\d+$", "i", 1),
  quiet: () => find(page, "^Quiet checks · \\d+$", "i", 1),
})

await shot("howitworks", async () => { await ready(page, "/settings/how-it-works") }, {})
await shot("sources", async () => { await ready(page, "/sources") }, {
  people: () => find(page, "^What people say$", "i", 1),
  cars: () => find(page, "^Where the cars are$", "i", 1),
})
await shot("permissions", async () => { await ready(page, "/settings") }, {
  ownSection: () => find(page, "^Agents do these on their own$", "i", 1),
  email: () => find(page, "^Email the customer$", "i", 2),
})
await shot("learning", async () => { await ready(page, "/settings/learning") }, {
  playbook: () => find(page, "^Playbook rules$", "i", 1),
  rates: () => find(page, "^Approved unchanged, by kind of action$", "i", 1),
})
await shot("orders", async () => { await ready(page, "/orders") }, {
  who: () => find(page, "^Who$", "i", 0, "th"),
})

writeFileSync(dir + "boxes.json", JSON.stringify(boxes, null, 2))
await browser.close()
