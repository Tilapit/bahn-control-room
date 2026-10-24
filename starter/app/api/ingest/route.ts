import { ingest, type IngestInput, processEntry } from "@/lib/ingest"

/** Accepts one timeline entry, stores it, then classifies and routes it in the background (?wait=1 to wait). */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as IngestInput | null
  if (!body?.order || !body.source || !body.authorType || !body.authorLabel || !(body.body || body.summary)) {
    return Response.json({ error: "Give order, source, authorType, authorLabel and body." }, { status: 400 })
  }
  try {
    const stored = await ingest(body)
    const work = processEntry(stored.entryId).catch((error) => { console.error("ingest processing", error); return null })
    if (new URL(request.url).searchParams.get("wait") === "1") return Response.json({ ...stored, result: await work })
    return Response.json(stored)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not store the entry." }, { status: 400 })
  }
}
