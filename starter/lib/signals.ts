// Does an order have a live signal (SPEC 4)? Orders with one get an agent run;
// the rest are checked by code only. Each reason is a short phrase for people.

import type { CaseFile } from "./case"

export function liveSignals(file: CaseFile): string[] {
  const reasons: string[] = []
  const { open } = file
  for (const alert of open.alerts) reasons.push(`${alert.taken ? "taken" : "open"} alert: ${alert.label.toLowerCase()}`)
  for (const task of open.tasks) reasons.push(`open task: ${task.label.toLowerCase()}`)
  for (const incident of open.incidents) reasons.push(`open incident: ${incident.label}`)
  for (const _claim of open.claims) reasons.push("unresolved handover claim")
  for (const proposal of open.proposals) reasons.push(`earlier agent proposal ${proposal.state}`)
  for (const thread of open.supportInbox) reasons.push(thread.linked ? "open support inbox thread" : "unlinked support message may concern it")
  for (const thread of open.conversations) if (thread.unanswered) reasons.push(`unanswered message in ${thread.channel.toLowerCase()}`)
  return reasons
}
