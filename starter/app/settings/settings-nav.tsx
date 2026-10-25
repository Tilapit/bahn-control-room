import Link from "next/link"

export function SettingsNav({ current }: { current: "permissions" | "learning" | "how" }) {
  return <nav className="filters" aria-label="Settings">
    <Link href="/settings" className="filter" aria-pressed={current === "permissions"}>Agent permissions</Link>
    <Link href="/settings/learning" className="filter" aria-pressed={current === "learning"}>Learning</Link>
    <Link href="/settings/how-it-works" className="filter" aria-pressed={current === "how"}>How it works</Link>
  </nav>
}
