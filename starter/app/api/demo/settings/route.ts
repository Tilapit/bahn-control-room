import { setAutoReply } from "@/lib/demo"

/** Demo: whether the simulated driver and sites answer agent questions by themselves. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { autoReply?: boolean }
  await setAutoReply(body.autoReply !== false)
  return Response.json({ autoReply: body.autoReply !== false })
}
