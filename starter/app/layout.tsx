import type { Metadata, Viewport } from "next"
import { connection } from "next/server"
import { hasApiKey } from "@/lib/agents/llm"
import { now } from "@/lib/clock"
import { openCardCount } from "@/lib/queue"
import { at } from "@/lib/time"
import { LiveRefresh } from "./ui/live-refresh"
import { Nav } from "./ui/nav"
import { TopSearch } from "./ui/top-search"
import "./globals.css"

export const metadata: Metadata = {
  title: { default: "Control Room", template: "%s · Control Room" },
  description: "Bahn car delivery control room. Fictional data.",
}

export const viewport: Viewport = {
  width: "device-width", initialScale: 1,
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#ffffff" }, { media: "(prefers-color-scheme: dark)", color: "#18181b" }],
}

// The ops desk reads the clock in Helsinki time; every other time is shown in its place's zone.
const DESK_ZONE = "Europe/Helsinki"

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection()
  const [openCards, clock] = await Promise.all([openCardCount(), now()])
  return <html lang="en">
    <body>
      <div className="app">
        <aside className="rail">
          <div className="brand"><span className="brand-mark" aria-hidden="true">B</span>Bahn Control Room</div>
          <Nav openCards={openCards} />
          <div className="rail-foot"><b>Fictional data</b>No real people, cars or bookings.<a className="rail-demo" href="/demo">Demo controls</a></div>
        </aside>
        <div className="main">
          <header className="topbar">
            <TopSearch />
            {!hasApiKey() && <a className="demo-mode" href="/demo" title="No API key is set, so agents cannot run live. Everything agents did here was recorded from real runs; the Demo page replays recorded scenarios.">Showing recorded agent runs</a>}
            <div className="clock" title="The app runs on a simulated clock that starts at the data snapshot.">
              <span className="faint">Demo clock</span><span className="num">{at(clock, DESK_ZONE).replace(/ EE[S]?T$/, "")} Helsinki time</span>
            </div>
          </header>
          {children}
        </div>
        <LiveRefresh />
      </div>
    </body>
  </html>
}
