import { setAutonomyThreshold } from "@/lib/autonomy"
import { type Answers, setAnswersOn, setAutoReply } from "@/lib/demo"

/** Demo switches: whether the simulated driver and sites answer by themselves; after how many approvals For you suggests autonomy. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { autoReply?: boolean; autonomyThreshold?: number; answers?: { order?: string; value?: string } }
  if (typeof body.autoReply === "boolean") await setAutoReply(body.autoReply)
  if (body.answers?.order) await setAnswersOn(body.answers.order, (["always", "sometimes", "never"].includes(String(body.answers.value)) ? body.answers.value : "always") as Answers)
  if (typeof body.autonomyThreshold === "number") await setAutonomyThreshold(body.autonomyThreshold)
  return Response.json({ ok: true })
}
