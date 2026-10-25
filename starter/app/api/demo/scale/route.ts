import { addScaleOrders, removeScaleOrders, scaleState } from "@/lib/scale"

/** Demo: scale mode. On adds 900 synthetic quiet orders (1,000 in all); off removes them. Takes a few seconds. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { on?: boolean }
  try {
    if (body.on) {
      const result = await addScaleOrders()
      return Response.json({ ...(await scaleState()), message: `Added ${result.added} synthetic quiet orders, copied from ${result.templates} of the dataset's quiet orders.` })
    }
    const result = await removeScaleOrders()
    return Response.json({ ...(await scaleState()), message: result.removed ? `Removed ${result.removed} synthetic orders.` : "Scale mode was already off." })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Scale mode could not change." }, { status: 500 })
  }
}

export async function GET() {
  return Response.json(await scaleState())
}
