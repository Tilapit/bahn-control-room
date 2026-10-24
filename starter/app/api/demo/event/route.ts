import { playDemoEvent } from "@/lib/demo-scenarios"

/** Demo: play a scripted event. Agent work continues in the background. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { id?: string; mode?: string }
  try {
    return Response.json(await playDemoEvent(String(body.id ?? ""), body.mode === "replay" ? "replay" : "live"))
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not play the event." }, { status: 400 })
  }
}
