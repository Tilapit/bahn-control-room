import { callTodo, TodoError } from "@/lib/todos"

/** End a simulated call: `played` is how many of the script's lines were heard; the server takes the words from the script. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await request.json().catch(() => ({})) as { played?: number }
  try {
    return Response.json(await callTodo(id, Number(body.played) || 0))
  } catch (error) {
    if (error instanceof TodoError) return Response.json({ error: error.message }, { status: error.status })
    throw error
  }
}
