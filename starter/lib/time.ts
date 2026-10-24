// Time words for summaries and screens. Times are shown in the zone of the place
// they belong to (site, terminal), relative phrases against the simulated clock.

import { zoneName } from "./present/time"

const LOCALE = "en-GB"

function parse(value: unknown): Date | null {
  if (!value) return null
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function safeZone(zone: string | null | undefined): string {
  if (!zone) return "UTC"
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone: zone })
    return zone
  } catch {
    return "UTC"
  }
}

function fmt(date: Date, zone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: zone, hourCycle: "h23", ...options }).format(date).replace(",", "")
}

/** "16:00" */
export function clock(value: unknown, zone?: string | null): string {
  const date = parse(value)
  return date ? fmt(date, safeZone(zone), { hour: "2-digit", minute: "2-digit" }) : ""
}

/** "CEST" */
export function zoneShort(value: unknown, zone?: string | null): string {
  const date = parse(value)
  const tz = safeZone(zone)
  return date ? (tz === "UTC" ? "UTC" : zoneName(date, tz)) : ""
}

/** "Wed 21 Oct 16:00 CEST" */
export function at(value: unknown, zone?: string | null): string {
  const date = parse(value)
  if (!date) return ""
  const tz = safeZone(zone)
  return `${fmt(date, tz, { weekday: "short", day: "numeric", month: "short" })} ${clock(date, tz)} ${zoneShort(date, tz)}`
}

/** "Wed 21 Oct 12:00–16:00 CEST" or across days "Wed 21 Oct 12:00 – Thu 22 Oct 10:00 CEST" */
export function range(start: unknown, end: unknown, zone?: string | null): string {
  const from = parse(start)
  const to = parse(end)
  if (!from) return ""
  const tz = safeZone(zone)
  if (!to) return at(from, tz)
  const day = (d: Date) => fmt(d, tz, { weekday: "short", day: "numeric", month: "short" })
  if (day(from) === day(to)) return `${day(from)} ${clock(from, tz)}–${clock(to, tz)} ${zoneShort(from, tz)}`
  return `${day(from)} ${clock(from, tz)} – ${day(to)} ${clock(to, tz)} ${zoneShort(to, tz)}`
}

/** "21 October 2026, 16:00 CEST" for hover titles. */
export function long(value: unknown, zone?: string | null): string {
  const date = parse(value)
  if (!date) return ""
  const tz = safeZone(zone)
  return `${fmt(date, tz, { day: "numeric", month: "long", year: "numeric" })}, ${clock(date, tz)} ${zoneShort(date, tz)}`
}

/** "2 h 10 min", "45 min", "3 d" */
export function duration(minutes: number): string {
  const abs = Math.abs(Math.round(minutes))
  if (abs < 60) return `${abs} min`
  const hours = Math.floor(abs / 60)
  const rest = abs % 60
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`
  const days = Math.floor(hours / 24)
  const leftover = hours % 24
  return leftover && days < 3 ? `${days} d ${leftover} h` : `${days} d`
}

/** "in 2 h 10 min" / "3 h ago" / "now", against the simulated clock. */
export function relative(value: unknown, now: Date | string): string {
  const date = parse(value)
  const base = parse(now)
  if (!date || !base) return ""
  const minutes = Math.round((date.getTime() - base.getTime()) / 60000)
  if (Math.abs(minutes) < 1) return "now"
  return minutes > 0 ? `in ${duration(minutes)}` : `${duration(minutes)} ago`
}

/** "today 16:00", "tomorrow 16:00", "Fri 23 Oct 16:00": a day word against the simulated clock, in the place's zone. */
export function dayAndClock(value: unknown, now: Date | string, zone?: string | null): string {
  const date = parse(value)
  const base = parse(now)
  if (!date || !base) return ""
  const tz = safeZone(zone)
  const key = (d: Date) => fmt(d, tz, { year: "numeric", month: "2-digit", day: "2-digit" })
  const dayMs = 86_400_000
  const word = key(date) === key(base) ? "today"
    : key(date) === key(new Date(base.getTime() + dayMs)) ? "tomorrow"
    : key(date) === key(new Date(base.getTime() - dayMs)) ? "yesterday"
    : fmt(date, tz, { weekday: "short", day: "numeric", month: "short" })
  return `${word} ${clock(date, tz)}`
}

export function minutesUntil(value: unknown, now: Date | string): number | null {
  const date = parse(value)
  const base = parse(now)
  return date && base ? Math.round((date.getTime() - base.getTime()) / 60000) : null
}
