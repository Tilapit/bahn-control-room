// npm run footage [-- clip …] [--base http://localhost:3001]
// Records the demo footage with Playwright: one 1440×900 video per clip, at the pace a person reads (it pauses on
// every card), into ../demo-footage/, and writes ../demo-footage/SHOTLIST.md with what each clip shows, when, and how
// long it is. Each clip starts from the recorded morning with scale mode on (1,000 orders); the recorded morning is
// put back at the end. A recording has no mouse pointer, so the page draws one.
// Clips: for-you, scenario-1, scenario-2, scenario-6, scenario-7, autonomy, case-view, how-it-works.
// Scenario 2 and 7 are replays of recorded live runs (real speed); with an API key, scenario 2 also sends the reply.

import "dotenv/config"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { chromium, type Locator, type Page } from "playwright"
import { hasApiKey } from "@/lib/agents/llm"
import { resetOrderDecisions } from "@/lib/agents/reset"
import { getCase } from "@/lib/case"
import { closeDb } from "@/lib/db"
import { loadFixtures } from "@/lib/fixtures"
import { addScaleOrders, scaleState } from "@/lib/scale"

const OUT = resolve(join(process.cwd(), "..", "demo-footage"))
const SIZE = { width: 1440, height: 900 }

type Beat = { t: number; text: string }
type Clip = { id: string; file: string; title: string; about: string; run: (page: Page, beat: (text: string) => void) => Promise<void> }

// ---------------------------------------------------------------------------
// Human pace
// ---------------------------------------------------------------------------

const wait = (page: Page, ms: number) => page.waitForTimeout(ms)

/** Draw a pointer that follows the mouse, and remember where it was across page loads. */
const CURSOR = `(() => {
  const install = () => {
    if (document.getElementById("__pointer")) return
    const dot = document.createElement("div")
    dot.id = "__pointer"
    dot.setAttribute("aria-hidden", "true")
    Object.assign(dot.style, { position: "fixed", left: "0", top: "0", width: "20px", height: "20px", margin: "-10px 0 0 -10px", borderRadius: "50%",
      background: "rgba(31,111,235,0.25)", border: "2px solid rgba(31,111,235,0.85)", zIndex: "2147483647", pointerEvents: "none",
      transition: "transform 80ms linear, width 120ms, height 120ms" })
    const last = JSON.parse(sessionStorage.getItem("__pointer") || "[-60,-60]")
    const place = (x, y, scale) => { dot.style.transform = "translate(" + x + "px," + y + "px) scale(" + scale + ")" }
    place(last[0], last[1], 1)
    document.documentElement.appendChild(dot)
    let at = last
    addEventListener("mousemove", (event) => { at = [event.clientX, event.clientY]; place(at[0], at[1], 1); sessionStorage.setItem("__pointer", JSON.stringify(at)) }, true)
    addEventListener("mousedown", () => place(at[0], at[1], 0.7), true)
    addEventListener("mouseup", () => place(at[0], at[1], 1), true)
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install); else install()
})()`

async function point(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) return
  await page.mouse.move(box.x + Math.min(box.width / 2, 60), box.y + box.height / 2, { steps: 24 })
  await wait(page, 350)
}

async function click(page: Page, target: Locator): Promise<void> {
  await point(page, target)
  await target.click()
  await wait(page, 500)
}

async function type(page: Page, target: Locator, text: string): Promise<void> {
  await click(page, target)
  await target.pressSequentially(text, { delay: 65 })
  await wait(page, 600)
}

/** Scroll like a person: smoothly, a screen at a time, with time to read. */
async function scrollBy(page: Page, pixels: number, readMs = 1800): Promise<void> {
  await page.evaluate((top) => window.scrollBy({ top, behavior: "smooth" }), pixels)
  await wait(page, 700 + readMs)
}

async function scrollTo(page: Page, target: Locator, readMs = 1800): Promise<void> {
  await target.evaluate((element) => element.scrollIntoView({ behavior: "smooth", block: "start" }))
  await page.evaluate(() => window.scrollBy({ top: -70, behavior: "smooth" }))
  await wait(page, 800 + readMs)
}

async function go(page: Page, base: string, path: string): Promise<void> {
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" })
  await wait(page, 800)
}

/** Wait for something the agents or the Executor are still doing, checking the page now and then. */
async function until(page: Page, target: Locator, seconds: number): Promise<boolean> {
  return target.first().waitFor({ timeout: seconds * 1000 }).then(() => true, () => false)
}

const row = (page: Page, text: string) => page.locator("article.row", { hasText: text }).first()

// ---------------------------------------------------------------------------
// The clips
// ---------------------------------------------------------------------------

function clips(base: string): Clip[] {
  return [
    {
      id: "for-you", file: "01-for-you-1000-orders.webm", title: "For you, with 1,000 orders",
      about: "Scale mode is on: the dataset's 100 orders plus 900 synthetic quiet copies. For you still holds only the cards that need a person, in the order something is lost, and the header counts the rest.",
      run: async (page, beat) => {
        await go(page, base, "/")
        beat("For you opens: the header counts what needs a person, what agents are handling, and the orders with nothing open")
        await point(page, page.locator(".page-sub"))
        await wait(page, 4500)
        beat("The safety case is first, then the earliest consequence")
        await point(page, page.locator("article.row").first())
        await wait(page, 3500)
        beat("Scrolling the list: each row says what is lost and when, and what the agent proposes")
        for (let index = 0; index < 4; index += 1) await scrollBy(page, 620, 2200)
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }))
        await wait(page, 1500)
        beat("Orders: all 1,000, the ones with something open first")
        await click(page, page.locator("nav[aria-label='Main'] a", { hasText: "Orders" }))
        await wait(page, 3500)
        await scrollBy(page, 700, 1500)
        beat("Search finds any of them by plate, name, city or anything said in a message")
        await type(page, page.locator(".search-box input").first(), "Bentley Hamburg")
        await wait(page, 3500)
        await page.keyboard.press("Escape")
        await wait(page, 800)
      },
    },
    {
      id: "scenario-1", file: "02-scenario-1-ferry-sold-out.webm", title: "Scenario 1: ferry sold out, approve with undo",
      about: "CD-420299. The agent first checked the timed-out booking with the ferry line, then re-checked the quote and proposes the Sat 24 Oct 14:00 sailing and a hotel. Approve, undo inside the 8 seconds, approve again; the Executor books it (simulated) and the order shows it.",
      run: async (page, beat) => {
        const file = await getCase("CD-420299")
        if (file) await resetOrderDecisions(file.order.id)
        await go(page, base, "/")
        const card = row(page, "BMW M4: ferry sold out")
        beat("The ferry card in For you: what is lost and when, and the proposal in one line")
        await point(page, card)
        await wait(page, 3000)
        beat("Opened: what happened, what the agent found with a source for each fact, and what it proposes")
        await click(page, card.locator(".row-head"))
        await wait(page, 4000)
        await scrollBy(page, 330, 5500)
        await scrollBy(page, 300, 4500)
        beat("Approve: the toast counts down the 8-second undo window")
        await click(page, card.locator(".row-actions .btn.primary"))
        await wait(page, 2500)
        beat("Undo inside the window: nothing was booked and the card comes back")
        await click(page, page.locator(".toast button", { hasText: "Undo" }))
        await wait(page, 2500)
        const again = row(page, "BMW M4: ferry sold out")
        await again.scrollIntoViewIfNeeded()
        if (await again.getAttribute("data-open") !== "true") await click(page, again.locator(".row-head"))
        beat("Approve again and let the window run out")
        await click(page, again.locator(".row-actions .btn.primary"))
        await wait(page, 10_500)
        beat("Booked. The order shows the ferry and the hotel as booked, and the Executor's entries on the timeline")
        await go(page, base, "/orders/CD-420299")
        await wait(page, 3500)
        await scrollTo(page, page.locator("section[aria-label='Route and travel']"), 5000)
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }))
        await scrollTo(page, page.locator("section[aria-label='Timeline']"), 6000)
      },
    },
    {
      id: "scenario-2", file: "03-scenario-2-red-warning-light-replay.webm", title: "Scenario 2: red warning light (replay of a live run)",
      about: "CD-420322, played back from a recorded live run at its real speed: the driver's message, the Classifier, the Investigator on Opus asking the driver if they are safe and where, the simulated driver's answer, recovery look-ups, and the safety card. Then a person replies \"call the seller first\" and the agent continues live.",
      run: async (page, beat) => {
        await go(page, base, "/demo")
        beat("Demo controls: replay the recorded live run of scenario 2")
        const event = page.locator(".demo-events li", { hasText: "Scenario 2" })
        await click(page, event.locator("button", { hasText: "Replay" }))
        await wait(page, 4000)
        beat("The driver's phone: the message about the red warning light")
        await scrollTo(page, page.locator(".demo-grid"), 6000)
        beat("Agents: the Investigator works (on Opus, a safety case); the row moves with each step")
        await go(page, base, "/agents")
        await wait(page, 8000)
        await until(page, page.locator(".run-row", { hasText: "Waiting for driver" }), 120)
        beat("It asked the driver and waits for the answer")
        await wait(page, 6000)
        await go(page, base, "/demo")
        await scrollTo(page, page.locator(".demo-grid"), 7000)
        await go(page, base, "/agents")
        const waiting = await until(page, page.locator(".run-row", { hasText: "Waiting for you" }), 200)
        beat(waiting ? "The card is ready: Waiting for you" : "Still working")
        await wait(page, 4000)
        await go(page, base, "/")
        const card = row(page, "Bentley Continental GT")
        beat("The safety card is first in For you")
        await point(page, card)
        await wait(page, 3500)
        await click(page, card.locator(".row-head"))
        beat("What the driver said, the stale GPS, the customer's instruction, the promise, and the recovery quotes, each with its source")
        await wait(page, 5000)
        await scrollBy(page, 330, 6000)
        await scrollBy(page, 330, 5000)
        if (!hasApiKey()) return
        // The reply box is there only while the replayed card is open and current; if it was replaced, the clip ends here.
        if (!(await card.locator(".row-reply input").isVisible().catch(() => false))) return
        beat("A person writes one sentence back instead of choosing an option")
        await type(page, card.locator(".row-reply input"), "call the seller first")
        await click(page, card.locator(".row-reply button", { hasText: "Send to agent" }))
        await wait(page, 10_000)
        beat("After the undo window the same agent continues with the reply, live")
        await go(page, base, "/agents")
        const next = await until(page, page.locator(".run-row", { hasText: "Waiting for you" }), 180)
        await wait(page, 3000)
        if (!next) return
        await go(page, base, "/")
        const updated = row(page, "Bentley Continental GT")
        beat("Its next card, after the reply")
        await click(page, updated.locator(".row-head"))
        await wait(page, 6000)
        await scrollBy(page, 330, 5000)
      },
    },
    {
      id: "scenario-6", file: "04-scenario-6-conflicting-evidence.webm", title: "Scenario 6: the driver's words against the GPS",
      about: "CD-420603. The driver says they are in the queue before the terminal; the last GPS shows 1,772 km to go. The Verifier found the conflict and code moved the case to Opus. The card shows both statements with their sources and the gap, and keeps the booked crossing. The source chips open the records.",
      run: async (page, beat) => {
        await go(page, base, "/")
        const card = row(page, "Volkswagen Golf")
        beat("The ferry check-in card: closes at 14:00 Hamburg time")
        await point(page, card)
        await wait(page, 3500)
        await click(page, card.locator(".row-head"))
        beat("Both statements, with their sources: the driver's messages and the GPS, and the gap between them")
        await wait(page, 5000)
        await scrollBy(page, 300, 7000)
        await scrollBy(page, 300, 5000)
        beat("The quiet line: investigated on Opus, moved to the senior model because records disagree")
        await point(page, card.locator(".run-line"))
        await wait(page, 4000)
        beat("A source chip opens the GPS record on the order's timeline")
        const gps = card.locator("a.chip", { hasText: "GPS" }).first()
        await point(page, gps)
        await wait(page, 2500)
        await gps.click()
        await page.waitForLoadState("networkidle")
        await wait(page, 6000)
        beat("The driver's message chip opens what the driver wrote, with the time")
        await page.goBack({ waitUntil: "networkidle" })
        await wait(page, 1500)
        const back = row(page, "Volkswagen Golf")
        if (await back.getAttribute("data-open") !== "true") await click(page, back.locator(".row-head"))
        const driver = back.locator("a.chip", { hasText: "Driver" }).first()
        await point(page, driver)
        await driver.click()
        await page.waitForLoadState("networkidle")
        await wait(page, 6000)
      },
    },
    {
      id: "scenario-7", file: "05-scenario-7-strike-and-lille-protest.webm", title: "Scenario 7: a rail strike and a protest near Lille",
      about: "Two disruption notices, noticed before any driver says anything. The rail strike card (CD-420123) cites the rail operator's notice and says the driver has not confirmed it. Then the Lille protest is published on the Demo page and replayed: one card covers both orders it touches.",
      run: async (page, beat) => {
        await go(page, base, "/")
        const strike = row(page, "rail strike")
        beat("The rail strike card: the Monitor matched the notice to the driver's booked train")
        await point(page, strike)
        await wait(page, 3000)
        await click(page, strike.locator(".row-head"))
        beat("It cites the rail operator's notice and says nobody on the ground has confirmed it")
        await wait(page, 5000)
        await scrollBy(page, 330, 6000)
        await scrollBy(page, 330, 4000)
        beat("Demo controls: the regional traffic service publishes a protest notice near Lille (a replay of the recorded live run)")
        await go(page, base, "/demo")
        const event = page.locator(".demo-events li", { hasText: "Scenario 7" })
        await point(page, event)
        await wait(page, 3000)
        await click(page, event.locator("button", { hasText: "Replay" }))
        await wait(page, 3000)
        beat("Agents: one Investigator run for both orders")
        await go(page, base, "/agents")
        await wait(page, 6000)
        await until(page, page.locator(".run-row", { hasText: "Waiting for you" }).filter({ hasText: "CD-420692" }), 150)
        await wait(page, 3000)
        await go(page, base, "/")
        const group = row(page, "2 orders")
        beat("One card, two orders, one cause: each order's effect, and the source")
        await point(page, group)
        await wait(page, 3000)
        await click(page, group.locator(".row-head"))
        await wait(page, 5000)
        await scrollBy(page, 330, 6000)
      },
    },
    {
      id: "autonomy", file: "06-autonomy-suggestion.webm", title: "Autonomy grows: the suggestion after unchanged approvals",
      about: "The Demo page lowers the suggestion threshold to 2. Two ferry cards approved as proposed (CD-420299 and CD-420154); For you then offers once to let the agent book ferries under that cost without asking. Yes changes the permission and logs who and why. Customer contact can never become automatic.",
      run: async (page, beat) => {
        for (const reference of ["CD-420299", "CD-420154"]) { const file = await getCase(reference); if (file) await resetOrderDecisions(file.order.id) }
        await go(page, base, "/demo")
        beat("Demo controls: suggest autonomy after 2 unchanged approvals (5 by default)")
        const threshold = page.locator("select[aria-label='Approvals before the autonomy suggestion']")
        await point(page, threshold)
        await threshold.selectOption("2")
        await wait(page, 2500)
        await go(page, base, "/")
        for (const text of ["BMW M4: ferry sold out", "Audi Q8 e-tron: ferry sold out"]) {
          const card = row(page, text)
          beat(`Approve the ferry card as proposed (${text.split(":")[0]})`)
          await click(page, card.locator(".row-head"))
          await wait(page, 3500)
          await click(page, card.locator(".row-actions .btn.primary"))
          await wait(page, 10_500)
        }
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }))
        await wait(page, 1500)
        beat("For you offers once: let the agent book these without asking, up to the highest approved cost")
        const suggestion = page.locator(".suggestion")
        await until(page, suggestion, 20)
        await point(page, suggestion)
        await wait(page, 6000)
        beat("Yes: the permission changes, and the change is logged")
        await click(page, suggestion.locator("button").first())
        await wait(page, 3500)
        await go(page, base, "/settings")
        beat("Agent permissions: the ferry booking is now automatic up to that cost; customer contact stays locked")
        await wait(page, 4000)
        await scrollBy(page, 500, 4500)
        await scrollTo(page, page.locator("h2", { hasText: "Changes" }), 5000)
      },
    },
    {
      id: "case-view", file: "07-case-view-with-sources.webm", title: "The order page: one timeline, every fact with its source",
      about: "CD-420322. The status sentence, key times each with its source and zone, what was agreed (stated or confirmed), the open card, and the one timeline across driver chat, support, email, GPS, internal notes, bookings and agents, with filters. Times are absolute on hover.",
      run: async (page, beat) => {
        await go(page, base, "/orders/CD-420322")
        beat("The header: what is wrong and what is lost next, the car, route, driver and customer")
        await point(page, page.locator(".case-status"))
        await wait(page, 5000)
        beat("Key times, each in its own place's time zone, each with the record it comes from")
        await point(page, page.locator("section[aria-label='Key times']"))
        await wait(page, 4500)
        beat("Agreed: what people said, marked stated or confirmed, with the source and time")
        await scrollTo(page, page.locator("section[aria-label='Agreed and stated']"), 5000)
        beat("The timeline: every channel on one order, newest first")
        await scrollTo(page, page.locator("section[aria-label='Timeline']"), 3500)
        for (const filter of ["Driver", "GPS", "Internal", "All"]) {
          const chip = page.locator(".filters button", { hasText: filter }).first()
          if (!(await chip.count())) continue
          beat(`Filter: ${filter}`)
          await click(page, chip)
          await wait(page, 3500)
        }
        beat("Hover a time for the full date and zone")
        await point(page, page.locator(".entry-time").nth(2))
        await wait(page, 3500)
        await scrollBy(page, 700, 3500)
      },
    },
    {
      id: "how-it-works", file: "08-how-it-works.webm", title: "How it works",
      about: "Settings → How it works, for an operations manager: the flow from a message to a decision, where each kind of information comes from now and in production, which model does which job and why, what agents may do alone, and the numbers measured on the recorded morning.",
      run: async (page, beat) => {
        await go(page, base, "/settings")
        beat("Settings → How it works")
        await click(page, page.locator("nav[aria-label='Settings'] a", { hasText: "How it works" }))
        await wait(page, 2500)
        beat("The flow: message or signal, Classifier, urgency and routing in code, Investigator, Verifier, For you, a person, Executor")
        await point(page, page.locator(".dg-wrap"))
        await wait(page, 8000)
        await scrollBy(page, 420, 6000)
        beat("Where the information comes from, today and in production")
        await scrollTo(page, page.locator("section[aria-label='Where the information comes from']"), 7000)
        beat("Who does which job, and why")
        await scrollTo(page, page.locator("section[aria-label='Which model does what']"), 7000)
        beat("What the agent may do alone, and what needs a person's yes")
        await scrollTo(page, page.locator("section[aria-label='What agents may do alone']"), 6000)
        beat("Measured on the recorded morning: runs, model mix, cost and time")
        await scrollTo(page, page.locator("section[aria-label='Measured']"), 9000)
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** The video's length, from Playwright's own ffmpeg; the script's own timing when that is not available. */
function length(file: string, fallbackMs: number): number {
  try {
    const ffmpeg = ["ffmpeg-1013", "ffmpeg-1011"].map((dir) => join(homedir(), "Library", "Caches", "ms-playwright", dir, "ffmpeg-mac")).find(existsSync)
    if (!ffmpeg) return fallbackMs
    execFileSync(ffmpeg, ["-i", file], { stdio: "pipe" })
  } catch (error) {
    const text = String((error as { stderr?: Buffer }).stderr ?? "")
    const match = text.match(/Duration: (\d+):(\d+):(\d+\.\d+)/)
    if (match) return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000
  }
  return fallbackMs
}

const mmss = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}`

async function fresh(): Promise<void> {
  await loadFixtures()
  if (!(await scaleState()).on) await addScaleOrders()
}

async function main() {
  const args = process.argv.slice(2)
  const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : process.env.APP_URL ?? "http://localhost:3001"
  const all = clips(base)
  const only = args.filter((arg) => !arg.startsWith("--") && arg !== base)
  const chosen = all.filter((clip) => !only.length || only.includes(clip.id))
  if (!chosen.length) throw new Error(`Usage: npm run footage -- [${all.map((clip) => clip.id).join(" | ")}]`)
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch()
  const results: { clip: Clip; ms: number; beats: Beat[] }[] = []
  try {
    for (const clip of chosen) {
      await fresh()
      const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: join(OUT, ".raw"), size: SIZE }, colorScheme: "light", deviceScaleFactor: 1 })
      await context.addInitScript(CURSOR)
      const page = await context.newPage()
      const started = Date.now()
      const beats: Beat[] = []
      console.log(`Recording ${clip.id}…`)
      try {
        await clip.run(page, (text) => { beats.push({ t: Date.now() - started, text }); console.log(`  ${mmss(Date.now() - started)} ${text}`) })
        await wait(page, 1500)
      } catch (error) {
        console.error(`  ${clip.id} stopped: ${error instanceof Error ? error.message.split("\n")[0] : error}`)
      }
      const video = page.video()
      const ms = Date.now() - started
      await context.close()
      const target = join(OUT, clip.file)
      if (video) { await rm(target, { force: true }); await rename(await video.path(), target) }
      results.push({ clip, ms: length(target, ms), beats })
    }
  } finally {
    await browser.close()
    await rm(join(OUT, ".raw"), { recursive: true, force: true })
    await loadFixtures()
  }
  // The shot list keeps clips recorded earlier when only some are recorded again.
  const listFile = join(OUT, "SHOTLIST.md")
  const previous = existsSync(listFile) ? await readFile(listFile, "utf8") : ""
  const sections = new Map<string, string>()
  for (const part of previous.split(/\n(?=## )/).slice(1)) sections.set(part.match(/`([^`]+\.webm)`/)?.[1] ?? part, part.trim())
  for (const { clip, ms, beats } of results) {
    sections.set(clip.file, [`## ${clip.title}`, "", `\`${clip.file}\` · ${mmss(ms)} · 1440×900`, "", clip.about, "", ...beats.map((beat) => `- ${mmss(beat.t)} ${beat.text}`)].join("\n"))
  }
  const ordered = all.map((clip) => sections.get(clip.file)).filter(Boolean)
  const total = [...results].reduce((sum, item) => sum + item.ms, 0)
  await writeFile(listFile, [
    "# Demo footage: shot list",
    "",
    "Recorded with `npm run footage` (Playwright, 1440×900, light theme) against the app with scale mode on (1,000 orders), starting from the recorded morning. Times in each list are from the start of the clip. Scenario 2 and 7 replay recorded live runs at their real speed: the waiting is real agent time, so cut it in the edit. The blue circle is the pointer, drawn by the page because a recording has none.",
    "",
    ...ordered.flatMap((section) => [section!, ""]),
  ].join("\n"))
  console.log(`\n${results.length} clip${results.length === 1 ? "" : "s"}, ${mmss(total)} in all, in ${OUT}`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDb)
