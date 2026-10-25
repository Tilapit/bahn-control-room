import { logTodo, TodoError } from "@/lib/todos"

/** Log what happened on a call the person made: refused without words; then the timeline, the facts, and the agent. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await request.json().catch(() => ({})) as { note?: string | null }
  try {
    return Response.json(await logTodo(id, body.note ?? ""))
  } catch (error) {
    if (error instanceof TodoError) return Response.json({ error: error.message }, { status: error.status })
    throw error
  }
}
