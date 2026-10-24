import { now } from "@/lib/clock"
import { type Level, setPolicy } from "@/lib/policies"

/** Settings: change what an agent may do on its own. Customer contact can never become automatic (enforced in setPolicy). */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { action?: string; level?: string; limitEur?: number | null }
  const level = (["auto", "approval", "never"] as const).find((value) => value === body.level)
  if (!level) return Response.json({ error: "Choose a level." }, { status: 400 })
  try {
    const limit = typeof body.limitEur === "number" && body.limitEur > 0 ? body.limitEur : null
    await setPolicy(String(body.action ?? ""), level as Level, { limitEur: limit, actor: "Ops", reason: "Changed in Settings", at: await now() })
    return Response.json({ ok: true })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "That did not work." }, { status: 400 })
  }
}
