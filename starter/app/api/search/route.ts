import { search } from "@/lib/case"

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? ""
  if (!query) return Response.json({ hits: [] })
  return Response.json({ hits: await search(query, 8) })
}
