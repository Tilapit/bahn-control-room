"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Icon } from "./icons"

const LINKS = [
  { href: "/", label: "For you", icon: "inbox", match: (path: string) => path === "/" },
  { href: "/agents", label: "Agents", icon: "bot", match: (path: string) => path.startsWith("/agents") },
  { href: "/orders", label: "Orders", icon: "list", match: (path: string) => path.startsWith("/orders") },
  { href: "/settings", label: "Settings", icon: "settings", match: (path: string) => path.startsWith("/settings") },
]

/** The Demo controls link at the foot of the rail, marked while you are on it. */
export function DemoLink() {
  const path = usePathname()
  return <Link className="rail-demo" href="/demo" aria-current={path.startsWith("/demo") ? "page" : undefined}>Demo controls</Link>
}

export function Nav({ openCards }: { openCards: number }) {
  const path = usePathname()
  return <nav aria-label="Main">
    {LINKS.map((link) => <Link key={link.href} href={link.href} className="nav-link" aria-current={link.match(path) ? "page" : undefined}>
      <Icon name={link.icon} />
      <span>{link.label}</span>
      {link.href === "/" && openCards > 0 && <span className="count num" aria-label={`${openCards} need you`}>{openCards}</span>}
    </Link>)}
  </nav>
}
