// Who is on shift, without the database, so the browser can use it too: "You" ("Ops" in the records), the two
// fictional colleagues, and the rule for a claim that has gone quiet.

/** The person using the app. Takeovers and decisions are recorded as "Ops". */
export const YOU = "Ops"

/** A claim with no action for longer than this (simulated minutes) is shown as gone quiet: free to take over. */
export const STALE_MINUTES = 30

export type Colleague = { name: string; initials: string; tone: string; awayMinutes?: number; claim?: { reference: string; minutesAgo: number } }

/** Fictional colleagues. Their claims are seeded relative to the simulated clock when the recorded morning loads. */
export const COLLEAGUES: Colleague[] = [
  { name: "Anna L.", initials: "AL", tone: "violet", claim: { reference: "CD-420702", minutesAgo: 9 } },
  { name: "Mikko P.", initials: "MP", tone: "blue", awayMinutes: 35, claim: { reference: "CD-420071", minutesAgo: 41 } },
]

export const initialsOf = (name: string) => name === YOU ? "Y" : COLLEAGUES.find((colleague) => colleague.name === name)?.initials ?? name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()

/** "You", or the colleague's name. */
export const personWords = (name: string) => name === YOU ? "You" : name

/** Gone quiet: claimed longer ago than STALE_MINUTES and nothing done since by the person who claimed it. */
export function isStale(claim: { at: string; lastActivityAt: string | null }, now: Date): boolean {
  const last = new Date(claim.lastActivityAt ?? claim.at).getTime()
  return now.getTime() - last > STALE_MINUTES * 60_000
}

/** Minutes since the claim's last activity, for "no activity 41 min". */
export const quietMinutes = (claim: { at: string; lastActivityAt: string | null }, now: Date) => Math.max(0, Math.round((now.getTime() - new Date(claim.lastActivityAt ?? claim.at).getTime()) / 60_000))

