import { openTodos } from "@/lib/todos"

/** The calls people were handed and have not logged yet. */
export async function GET() {
  return Response.json({ todos: await openTodos() })
}
