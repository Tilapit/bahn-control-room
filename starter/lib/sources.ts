// Where every record on an order's timeline comes from, in one list: the label people read, the small icon shown
// next to each record, and the system that would send it in production. The Sources page, the timeline and the
// cards all use it, so one channel looks the same everywhere.

export type SourceKind = { key: string; label: string; icon: string; sources: string[]; production: string }

export const SOURCE_KINDS: SourceKind[] = [
  { key: "driver", label: "Driver chat", icon: "driver", sources: ["driver_chat"], production: "Driver app chat and WhatsApp message feeds" },
  { key: "support", label: "Support chat (Intercom)", icon: "chat", sources: ["support"], production: "Intercom webhook, one event per new message" },
  { key: "internal", label: "Internal notes (Slack)", icon: "hash", sources: ["slack"], production: "Slack Events API, from the operations channels" },
  { key: "email", label: "Email", icon: "mail", sources: ["email"], production: "The shared support mailbox" },
  { key: "calls", label: "Calls", icon: "phone", sources: ["call"], production: "Call transcription from the phone system" },
  { key: "gps", label: "GPS", icon: "pin", sources: ["gps"], production: "GPS provider feed from the driver app" },
  { key: "bookings", label: "Bookings", icon: "ticket", sources: ["booking"], production: "Ferry, rail and hotel booking APIs" },
  { key: "quotes", label: "Quotes", icon: "tag", sources: ["quote"], production: "The same booking APIs: availability and price checks" },
  { key: "alerts", label: "Alerts", icon: "bell", sources: ["alert"], production: "The ops platform's monitoring and the disruption feeds" },
  { key: "agents", label: "Agents", icon: "bot", sources: ["agent"], production: "This control room's agents" },
  { key: "people", label: "People", icon: "person", sources: ["person"], production: "This control room: decisions, takeovers and notes" },
  { key: "records", label: "Order records", icon: "doc", sources: ["order", "system"], production: "Bahn's operations platform" },
]

const BY_SOURCE = new Map(SOURCE_KINDS.flatMap((kind) => kind.sources.map((source) => [source, kind] as const)))

/** The kind a timeline entry's source belongs to ("driver_chat" → Driver chat). */
export function sourceKind(source: string | null | undefined): SourceKind {
  return BY_SOURCE.get(source ?? "") ?? SOURCE_KINDS[SOURCE_KINDS.length - 1]
}
