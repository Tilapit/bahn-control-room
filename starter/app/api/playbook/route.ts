import { approveRule, dismissRule } from "@/lib/learning"

/** Approve (after the recorded evals pass) or dismiss a suggested playbook rule. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { id?: string; answer?: string }
  if (!body.id || (body.answer !== "approve" && body.answer !== "dismiss")) return Response.json({ error: "Say which rule and approve or dismiss." }, { status: 400 })
  try {
    if (body.answer === "dismiss") {
      await dismissRule(body.id)
      return Response.json({ ok: true, message: "Dismissed. The agents do not get this rule." })
    }
    const result = await approveRule(body.id)
    return Response.json({ ok: result.passed, passed: result.passed, message: result.passed
      ? `The recorded evals pass (${result.summary}). The rule is now part of the Investigator's instructions.`
      : `The recorded evals did not pass (${result.summary}). The rule was not added.` })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not decide this rule." }, { status: 409 })
  }
}
