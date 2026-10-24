import { finalizeDecision } from "@/lib/decisions"

/** The page calls this when the undo window closes. Safe to call twice; the server's own timer may have run it already. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return Response.json(await finalizeDecision(id))
}
