import { similarCases } from "@/lib/learning"

/** Up to 3 past decisions like this card's proposal, for "Similar past cases" in the detail pane. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return Response.json({ cases: await similarCases(id) })
}
