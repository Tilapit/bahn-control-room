"use client"

import { useEffect, useState } from "react"

type Theme = "light" | "dark" | "system"
const KEY = "bahn.theme"

/** Light by default; dark when the person picks it, or when they pick System and the OS is dark. Saved in this browser. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light")
  useEffect(() => {
    try { const saved = localStorage.getItem(KEY); if (saved === "dark" || saved === "system") setTheme(saved) } catch { /* light */ }
  }, [])
  function pick(next: Theme) {
    setTheme(next)
    document.documentElement.dataset.theme = next
    try { localStorage.setItem(KEY, next) } catch { /* lasts until reload */ }
  }
  return <span className="theme-toggle" role="group" aria-label="Theme">
    {(["light", "dark", "system"] as const).map((option) => <button key={option} type="button" aria-pressed={theme === option} onClick={() => pick(option)}>
      {option === "light" ? "Light" : option === "dark" ? "Dark" : "System"}
    </button>)}
  </span>
}

/** Runs before the page paints, so a saved Dark or System choice never flashes light first. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${KEY}");if(t==="dark"||t==="system")document.documentElement.dataset.theme=t}catch(e){}`
