import Link from "next/link"

export function SettingsNav({ current }: { current: "permissions" | "learning" }) {
  return <nav className="filters" aria-label="Settings">
    <Link href="/settings" className="filter" aria-pressed={current === "permissions"}>Agent permissions</Link>
    <Link href="/settings/learning" className="filter" aria-pressed={current === "learning"}>Learning</Link>
  </nav>
}
