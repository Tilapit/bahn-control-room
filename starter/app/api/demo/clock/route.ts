import { advance, resetToDemoStart } from "@/lib/clock"
import { runMonitor } from "@/lib/monitor"

/** Demo: move the simulated clock forward (the Monitor then looks at what the new time means), or back to the start. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { minutes?: number; reset?: boolean }
  const at = body.reset ? await resetToDemoStart() : await advance(Math.max(1, Math.min(24 * 60, Number(body.minutes ?? 15))))
  if (!body.reset) void runMonitor({ startAgents: true }).catch((error) => console.error("monitor after clock", error))
  return Response.json({ now: at.toISOString() })
}
