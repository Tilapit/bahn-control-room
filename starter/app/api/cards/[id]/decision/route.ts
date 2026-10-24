import { DecisionError, decide } from "@/lib/decisions"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await request.json().catch(() => ({})) as { optionId?: string; replyText?: string | null }
  if (!body.optionId) return Response.json({ error: "Choose an option." }, { status: 400 })
  try {
    return Response.json(await decide(id, body.optionId, body.replyText ?? null))
  } catch (error) {
    if (error instanceof DecisionError) return Response.json({ error: error.message }, { status: error.status })
    throw error
  }
}
