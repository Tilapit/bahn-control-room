import { advance, resetToDemoStart } from "@/lib/clock"

/** Demo: move the simulated clock forward, or back to the data snapshot. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { minutes?: number; reset?: boolean }
  const at = body.reset ? await resetToDemoStart() : await advance(Math.max(1, Math.min(24 * 60, Number(body.minutes ?? 15))))
  return Response.json({ now: at.toISOString() })
}
