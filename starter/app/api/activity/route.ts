import { activityVersion } from "@/lib/activity"

/** Polling fallback for browsers without a working event stream. */
export async function GET() {
  return Response.json({ version: await activityVersion() }, { headers: { "cache-control": "no-store" } })
}
