import { backupAccepts, backupState } from "@/lib/backup"

/** Demo: where the backup-driver case stands (an offer out, a yes, travel still booked). */
export async function GET() {
  return Response.json(await backupState())
}

/** Demo: the backup driver accepts the offered gig. Code then proposes cancelling the replaced driver's travel. */
export async function POST() {
  const result = await backupAccepts()
  return Response.json(result, { status: result.ok ? 200 : 409 })
}
