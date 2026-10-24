import { activityVersion } from "@/lib/activity"

export const dynamic = "force-dynamic"

const CHECK_MS = 1000
const HEARTBEAT_MS = 15_000

/** Server-sent events: a "version" event whenever agents, people or the clock change something. */
export async function GET(request: Request) {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setTimeout> | null = null
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let last = ""
      let lastSent = Date.now()
      const send = (text: string) => { try { controller.enqueue(encoder.encode(text)) } catch { /* closed */ } }
      send("retry: 3000\n\n")
      const tick = async () => {
        if (request.signal.aborted) return
        try {
          const version = await activityVersion()
          if (version !== last) {
            last = version
            lastSent = Date.now()
            send(`event: version\ndata: ${JSON.stringify({ version })}\n\n`)
          } else if (Date.now() - lastSent > HEARTBEAT_MS) {
            lastSent = Date.now()
            send(": still here\n\n")
          }
        } catch { /* the database is busy for a moment; try again */ }
        timer = setTimeout(tick, CHECK_MS)
      }
      request.signal.addEventListener("abort", () => {
        if (timer) clearTimeout(timer)
        try { controller.close() } catch { /* already closed */ }
      })
      await tick()
    },
    cancel() { if (timer) clearTimeout(timer) },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", connection: "keep-alive" } })
}
