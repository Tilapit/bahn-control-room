import type { Metadata, Viewport } from "next"
import { connection } from "next/server"
import { hasApiKey } from "@/lib/agents/llm"
import { now } from "@/lib/clock"
import { nowTeams } from "@/lib/queue"
import { railCounts } from "@/lib/shift"
import { at } from "@/lib/time"
import { LiveRefresh } from "./ui/live-refresh"
import { DemoLink, Nav } from "./ui/nav"
import { THEME_SCRIPT, ThemeToggle } from "./ui/theme-toggle"
import { TopSearch } from "./ui/top-search"
import "./globals.css"
import "./teams.css"
import "./learning.css"

export const metadata: Metadata = {
  title: { default: "Control Room", template: "%s · Control Room" },
  description: "Bahn car delivery control room. Fictional data.",
}

export const viewport: Viewport = {
  width: "device-width", initialScale: 1,
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f4f2ee" }, { media: "(prefers-color-scheme: dark)", color: "#151614" }],
}

// The ops desk reads the clock in Helsinki time; every other time is shown in its place's zone.
const DESK_ZONE = "Europe/Helsinki"

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection()
  // The badge counts what needs someone now, in the person's own view: Nav filters it in the browser.
  const [teams, clock, rail] = await Promise.all([nowTeams(), now(), railCounts()])
  // Light unless the person picked Dark or System in the rail (THEME_SCRIPT applies a saved choice before paint).
  return <html lang="en" data-theme="light" suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
    <body>
      <div className="app">
        <aside className="rail">
          <div className="brand"><span className="brand-mark" aria-hidden="true">B</span><span className="brand-name"><b>Bahn</b><span>Control room</span></span></div>
          <Nav nowTeams={teams} orders={rail.orders} working={rail.working} />
          <div className="rail-foot">
            <p className="rail-label">On shift</p>
            <ul className="shift" aria-label="On shift">
              {rail.shift.map((member) => <li key={member.name}><span className={`avatar ${member.tone}`} aria-hidden="true">{member.initials}</span><span className="shift-name">{member.name}</span><span className="shift-status">{member.status}</span></li>)}
            </ul>
            <div className="rail-running">
              <b><span className="live-dot" aria-hidden="true" />Agents running</b>
              <span>{rail.handledToday.toLocaleString("en-GB")} handled today without you</span>
            </div>
            <p className="rail-note">
              <span title="No real people, cars or bookings; the colleagues are fictional too.">Fictional data</span> · <span title={`The app runs on a simulated clock that starts at the data snapshot: ${at(clock, DESK_ZONE)}.`}>demo clock {at(clock, DESK_ZONE).replace(/ EE[S]?T$/, "").replace(/^\w+ \d+ \w+ /, "")}</span>
              {!hasApiKey() && <> · <a className="demo-mode" href="/demo" title="No API key is set, so agents cannot run live. Everything agents did here was recorded from real runs; the Demo page replays recorded scenarios.">recorded runs</a></>}
              {" · "}<DemoLink />
              <span className="rail-note-row"><ThemeToggle /></span>
            </p>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <TopSearch />
          </header>
          {children}
        </div>
        <LiveRefresh />
      </div>
    </body>
  </html>
}
