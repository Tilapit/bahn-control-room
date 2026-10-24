import { DecisionError, undo } from "@/lib/decisions"

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    return Response.json(await undo(id))
  } catch (error) {
    if (error instanceof DecisionError) return Response.json({ error: error.message }, { status: error.status })
    throw error
  }
}
