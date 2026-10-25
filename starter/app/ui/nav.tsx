"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { inView, type Team, viewLabel } from "@/lib/teams"
import { Icon } from "./icons"
import { useTeamView } from "./view-switcher"

const match = {
  forYou: (path: string) => path === "/",
  orders: (path: string) => path.startsWith("/orders"),
  agents: (path: string) => path.startsWith("/agents"),
  sources: (path: string) => path.startsWith("/sources"),
  settings: (path: string) => path.startsWith("/settings"),
}

/** The Demo controls link at the foot of the rail, marked while you are on it. */
export function DemoLink() {
  const path = usePathname()
  return <Link className="rail-demo" href="/demo" aria-current={path.startsWith("/demo") ? "page" : undefined}>Demo controls</Link>
}

/**
 * The rail: For you (what needs someone now, in the person's view) and Orders, then "Behind the scenes": Agents (how
 * many are at work), Sources and Settings. `nowTeams`: one entry per card that needs someone now.
 */
export function Nav({ nowTeams, orders, working }: { nowTeams: (Team & { safety?: boolean })[]; orders: number; working: number }) {
  const path = usePathname()
  const [view] = useTeamView()
  // A person's safety needs someone now in every view, as on For you.
  const openCards = nowTeams.filter((team) => team.safety || inView(team, view)).length
  const link = (href: string, label: string, icon: string, active: boolean, end?: React.ReactNode) =>
    <Link href={href} className="nav-link" aria-current={active ? "page" : undefined}><Icon name={icon} /><span>{label}</span>{end}</Link>
  return <nav aria-label="Main">
    {link("/", "For you", "inbox", match.forYou(path), openCards > 0 ? <span className="badge num" aria-label={`${openCards} need you now`} title={`${openCards} need you now: ${viewLabel(view)}`}>{openCards}</span> : null)}
    {link("/orders", "Orders", "list", match.orders(path), <span className="count num">{orders.toLocaleString("en-GB")}</span>)}
    <p className="rail-label">Behind the scenes</p>
    {link("/agents", "Agents", "bot", match.agents(path), <span className="count" title={working ? `${working} agent runs watching orders` : "No agent is at work"}>{working}</span>)}
    {link("/sources", "Sources", "database", match.sources(path))}
    {link("/settings", "Settings", "settings", match.settings(path))}
  </nav>
}
