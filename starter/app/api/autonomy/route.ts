import { answerSuggestion } from "@/lib/autonomy"

/** For you: the person answers the autonomy suggestion (Yes / Not now). Yes changes the policy and logs it. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { action?: string; answer?: string }
  try {
    const message = await answerSuggestion(String(body.action ?? ""), body.answer === "yes" ? "yes" : "not_now")
    return Response.json({ message })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "That did not work." }, { status: 400 })
  }
}
