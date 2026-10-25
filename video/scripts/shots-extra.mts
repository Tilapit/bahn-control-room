// Second pass: views scrolled to elements that sit below the first screen.
import { chromium } from "/Users/jannelappi/Projects/bahn-control-room/starter/node_modules/playwright/index.mjs"
import { writeFileSync, readFileSync } from "node:fs"
const base = "http://localhost:3001"
const dir = new URL("../public/shots/", import.meta.url).pathname
const boxes = JSON.parse(readFileSync(dir + "boxes.json", "utf8"))
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" })
await context.addInitScript(() => { try { localStorage.setItem("bahn.theme", "light") } catch {} })
const page = await context.newPage()

// Scrolls the innermost element matching `source` to the given position, then returns its box (after `climb` parents or the `until` ancestor).
async function view(source: string, block: "start" | "center", climb = 0, until = "", offset = 0) {
  const box = await page.evaluate(({ source, block, climb, until, offset }) => {
    const re = new RegExp(source, "i")
    const all = Array.from(document.body.querySelectorAll("*")).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && re.test((el as HTMLElement).innerText ?? "") })
    const inner = all.filter((el) => !all.some((o) => o !== el && el.contains(o)))
    let el = inner[0]
    if (!el) return null
    if (until) el = el.closest(until) ?? el
    for (let i = 0; i < climb && el.parentElement; i++) el = el.parentElement
    el.scrollIntoView({ block })
    if (offset) { window.scrollBy(0, offset); document.querySelectorAll("main, [class*=scroll]").forEach((s) => (s as HTMLElement).scrollBy?.(0, offset)) }
    return true
  }, { source, block, climb, until, offset })
  await page.waitForTimeout(500)
  return box
}
async function boxOf(source: string, climb = 0, until = "") {
  return page.evaluate(({ source, climb, until }) => {
    const re = new RegExp(source, "i")
    const all = Array.from(document.body.querySelectorAll("*")).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight && re.test((el as HTMLElement).innerText ?? "") })
    const inner = all.filter((el) => !all.some((o) => o !== el && el.contains(o)))
    let el = inner[inner.length - 1]
    if (!el) return null
    if (until) el = el.closest(until) ?? el
    for (let i = 0; i < climb && el.parentElement; i++) el = el.parentElement
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
  }, { source, climb, until })
}
async function go(path: string) { await page.goto(base + path, { waitUntil: "networkidle" }); await page.waitForTimeout(800) }

await go("/")
await page.locator(".inbox-row", { hasText: "CD-420322" }).first().locator("button").first().click().catch(() => {})
await view("Mikko P\\. · no activity", "center", 0, ".inbox-row")
boxes["foryou-mikko"] = { mikko: await boxOf("Mikko P\\. · no activity", 0, ".inbox-row") }
await page.screenshot({ path: dir + "foryou-mikko.png" })

await go("/agents/run_0e064073")
await view("^Sent back$", "center")
boxes["trace2"] = { sentBack: await boxOf("^Draft sent back by the second check"), outcome: await boxOf("^Proposed to a person") }
await page.screenshot({ path: dir + "trace2.png" })

await go("/agents")
await view("^Orders with nothing open", "center")
boxes["agents-quiet"] = { tiles: await boxOf("^Orders with nothing open", 1), cost: await boxOf("^Model use today") }
await page.screenshot({ path: dir + "agents-quiet.png" })

await go("/settings")
await view("^Email the customer$", "center")
boxes["permissions-email"] = { email: await boxOf("^Email the customer$", 2) }
await page.screenshot({ path: dir + "permissions-email.png" })

writeFileSync(dir + "boxes.json", JSON.stringify(boxes, null, 2))
for (const k of ["foryou-mikko", "trace2", "agents-quiet", "permissions-email"]) console.log(k, JSON.stringify(boxes[k]))
await browser.close()
