// Where a timeline entry came from, in words a person reads. Shared by the
// timeline build, the case file and the screens.

export const SOURCES = [
  "order", "gps", "driver_chat", "support", "slack", "email", "call",
  "booking", "quote", "alert", "agent", "person", "system",
] as const
export type Source = (typeof SOURCES)[number]

export type EntryKind = "message" | "position" | "booking" | "quote" | "alert" | "event" | "proposal" | "decision" | "fact"
export type EntryStatus = "claimed" | "verified" | "quote" | "booked" | "superseded" | "signal" | "done"

/** Raw dataset channel to timeline source (SPEC 5.2). */
export function sourceForChannel(channel: string | null | undefined): Source {
  switch (channel) {
    case "support_chat": return "support"
    case "internal_note": case "internal_notification": return "slack"
    case "driver_chat": case "app_chat": case "whatsapp": case "driver_app_chat": return "driver_chat"
    case "customer_email": case "email": return "email"
    case "site_call": return "call"
    // A chat with a pickup site's release desk is handled by support.
    case "site_chat": return "support"
    default: return "system"
  }
}

/** Long label, shown on a timeline entry. */
export const SOURCE_LABEL: Record<Source, string> = {
  order: "Order record",
  gps: "GPS (driver app)",
  driver_chat: "Driver chat",
  support: "Support chat (Intercom)",
  slack: "Internal (Slack)",
  email: "Email",
  call: "Phone call",
  booking: "Booking",
  quote: "Quote, not booked",
  alert: "Alert",
  agent: "Agent",
  person: "Ops",
  system: "System",
}

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  app_chat: "Driver app chat",
  driver_app_chat: "Driver app chat",
  site_chat: "Site chat",
  site_call: "Phone call with the site",
  customer_email: "Email",
}

export function sourceLabel(source: string, channel?: string | null): string {
  if (channel && CHANNEL_LABEL[channel]) return CHANNEL_LABEL[channel]
  return SOURCE_LABEL[source as Source] ?? "Record"
}

/** Filter chips on the order page. "All" is implicit. */
export const SOURCE_FILTERS: { key: string; label: string; sources: Source[] }[] = [
  { key: "driver", label: "Driver", sources: ["driver_chat"] },
  { key: "support", label: "Support", sources: ["support", "call"] },
  { key: "internal", label: "Internal", sources: ["slack"] },
  { key: "email", label: "Email", sources: ["email"] },
  { key: "gps", label: "GPS", sources: ["gps"] },
  { key: "bookings", label: "Bookings", sources: ["booking", "quote"] },
  { key: "alerts", label: "Alerts", sources: ["alert"] },
  { key: "agents", label: "Agents", sources: ["agent"] },
  { key: "people", label: "People", sources: ["person"] },
]

/** Who spoke, as the short first half of a source chip: "Driver · 08:42". */
export function chipWho(entry: { source: string; authorType: string | null; status: string | null }): string {
  switch (entry.source) {
    case "gps": return "GPS"
    case "quote": return "Quote, not booked"
    case "booking": return entry.status === "superseded" ? "Old booking" : "Booking"
    case "alert": return "Alert"
    case "agent": return "Agent"
    case "slack": return "Internal"
  }
  switch (entry.authorType) {
    case "driver": return "Driver"
    case "customer": return "Customer"
    case "site_contact": return "Site"
    case "handoff_contact": return "Handover contact"
    case "agent": return "Agent"
    case "operator": return "Ops"
  }
  if (entry.source === "person") return "Ops"
  if (entry.source === "order") return "Order"
  return "System"
}

type ChipInput = { source: string; channel: string | null; authorType: string | null; authorLabel: string | null; status: string | null; kind: string }

/** The short source for a chip on a card: "Driver", "Customer email", "Internal note", "Quote, not booked". */
export function chipLabel(entry: ChipInput): string {
  const inbound = entry.authorType === "driver" ? "Driver" : entry.authorType === "customer" ? "Customer"
    : entry.authorType === "site_contact" ? "Site" : entry.authorType === "handoff_contact" ? "Handover contact" : null
  if (entry.kind === "message") {
    switch (entry.source) {
      case "driver_chat": return inbound ?? (entry.authorType === "agent" ? "Agent to driver" : "Ops to driver")
      case "support": return inbound ? `${inbound}, support chat` : "Support chat"
      case "email": return inbound ? `${inbound} email` : "Email from Ops"
      case "call": return inbound ? `${inbound}, phone` : "Phone call"
      case "slack": return "Internal note"
      case "order": return inbound ? `${inbound} note` : "Order note"
    }
  }
  switch (entry.source) {
    case "gps": return "GPS"
    case "quote": return entry.status === "quote" ? "Quote, not booked" : "Availability check"
    case "booking": return entry.status === "superseded" ? "Old booking" : "Booking"
    case "alert": return "Alert"
    case "agent": return entry.authorLabel ?? "Agent"
    case "person": return entry.authorLabel ?? "Ops"
    case "slack": return "Internal"
  }
  if (entry.kind === "fact") return entry.authorLabel ?? "Order record"
  if (inbound) return inbound
  return entry.source === "order" ? "Order record" : "System"
}
