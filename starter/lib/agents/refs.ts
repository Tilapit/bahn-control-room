// Short citation handles for one agent run. The agent reads "[E12]" instead of
// "[tracking_observations:track-x4ec652df41547497]" and cites "E12"; code maps the
// handle back to the real timeline entry id. A handle exists only for an entry
// the agent was shown, so a finding cannot cite something the agent never read.

export class Refs {
  private byEntry = new Map<string, string>()
  private byHandle = new Map<string, string>()

  constructor(saved?: Record<string, string> | null) {
    for (const [handle, entryId] of Object.entries(saved ?? {})) {
      this.byHandle.set(handle, entryId)
      this.byEntry.set(entryId, handle)
    }
  }

  /** "[E12]" for an entry id, created on first use. */
  cite(entryId: string): string {
    return `[${this.handle(entryId)}]`
  }

  handle(entryId: string): string {
    const known = this.byEntry.get(entryId)
    if (known) return known
    const handle = `E${this.byHandle.size + 1}`
    this.byEntry.set(entryId, handle)
    this.byHandle.set(handle, entryId)
    return handle
  }

  /** The entry id behind "E12", "[E12]" or "e12". Null when the agent was never shown it. */
  resolve(cited: string | null | undefined): string | null {
    if (!cited) return null
    const handle = cited.trim().replace(/^\[|\]$/g, "").toUpperCase()
    return this.byHandle.get(handle) ?? (this.byEntry.has(cited) ? cited : null)
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.byHandle)
  }
}
