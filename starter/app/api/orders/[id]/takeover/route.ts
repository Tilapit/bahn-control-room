import { getCase } from "@/lib/case"
import { handBack, logAction, takeOver } from "@/lib/takeover"

/** Take an order over, log what you did, or hand it back to the agents. The person is "Ops" in this demo. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: reference } = await params
  const body = await request.json().catch(() => ({})) as { action?: string; note?: string }
  const file = await getCase(reference)
  if (!file) return Response.json({ error: `There is no order ${reference}.` }, { status: 404 })
  const note = typeof body.note === "string" ? body.note.slice(0, 600) : ""
  const result = body.action === "take" ? await takeOver(file.order.id, "Ops")
    : body.action === "take_over" ? await takeOver(file.order.id, "Ops", true)
    : body.action === "hand_back" ? await handBack(file.order.id, "Ops", note)
    : body.action === "log" ? await logAction(file.order.id, "Ops", note)
    : { ok: false, message: "Say take, take_over, log or hand_back." }
  return Response.json(result, { status: result.ok ? 200 : 409 })
}
