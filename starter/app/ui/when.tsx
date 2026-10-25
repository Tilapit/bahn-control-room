// Times as people read them: relative to the simulated clock, absolute on hover,
// in the zone of the place they belong to.

import { clock, dayAndClock, duration, long, minutesUntil, relative, zoneShort } from "@/lib/time"

/** "08:58" today, "Tue 14:02" on another day, in the given zone. */
export function shortTime(iso: string, now: string, zone: string | null): string {
  const text = dayAndClock(iso, now, zone)
  if (text.startsWith("today ")) return text.slice(6)
  if (text.startsWith("yesterday ")) return `yesterday ${text.slice(10)}`
  if (text.startsWith("tomorrow ")) return `tomorrow ${text.slice(9)}`
  // "Tue 20 Oct 14:02" → "Tue 20 Oct 14:02" stays explicit for older days.
  return text
}

export function When({ iso, now, zone, as = "short" }: { iso: string; now: string; zone: string | null; as?: "short" | "relative" | "day" | "clock" }) {
  const text = as === "relative" ? relative(iso, now)
    : as === "day" ? dayAndClock(iso, now, zone)
    : as === "clock" ? clock(iso, zone)
    : shortTime(iso, now, zone)
  return <time dateTime={iso} title={`${long(iso, zone)} (${relative(iso, now)})`}>{text}</time>
}

/**
 * A source chip: "Driver · 08:42", "GPS · 3 h old", "Quote, not booked · 07:00". Links to the timeline entry when given.
 * `named`: the chip is in a different zone from the rest of the page, so it says which ("14:13 EEST").
 */
export function SourceChip({ label, at, now, zone, href, named = false }: { label: string; at: string | null; now: string; zone: string | null; href?: string | null; named?: boolean }) {
  const age = at && label === "GPS" ? `${duration(-(minutesUntil(at, now) ?? 0))} old` : null
  const className = `chip${label.startsWith("Quote") ? " quote" : ""}`
  const body = <>{label}{at ? <> · {age ? <time dateTime={at} title={`${long(at, zone)} (${relative(at, now)})`}>{age}</time> : <><When iso={at} now={now} zone={zone} />{named ? ` ${zoneShort(at, zone)}` : ""}</>}</> : null}</>
  return href ? <a className={className} href={href}>{body}</a> : <span className={className}>{body}</span>
}
