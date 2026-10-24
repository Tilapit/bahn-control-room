import { ask } from "@/lib/agents/ask"

/** ⌘K: a question for the agents, answered read-only with its sources. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { question?: string }
  const question = String(body.question ?? "").trim().slice(0, 400)
  if (!question) return Response.json({ error: "Type a question." }, { status: 400 })
  try {
    return Response.json(await ask(question))
  } catch (error) {
    return Response.json({ error: `The agent could not answer: ${error instanceof Error ? error.message.slice(0, 120) : "error"}` }, { status: 500 })
  }
}
