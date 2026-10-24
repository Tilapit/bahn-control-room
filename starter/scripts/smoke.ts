// APP_URL=http://localhost:3001 npm run smoke
// Checks the running app: For you renders, every one of the 100 orders opens as a
// case page, and search finds orders by reference and by message text.

import { readFile } from "node:fs/promises"
import { join } from "node:path"

async function get(base: string, path: string): Promise<string> {
  const response = await fetch(`${base}${path}`)
  if (!response.ok) throw new Error(`${path} returned ${response.status}`)
  return response.text()
}

async function main(): Promise<void> {
  const base = process.env.APP_URL ?? "http://localhost:3001"
  const dataset = process.env.DATASET_DIR ?? join(process.cwd(), "..", "dataset", "data")
  const orders = (await readFile(join(dataset, "orders.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { reference: string })

  const home = await get(base, "/")
  if (!home.includes("For you")) throw new Error("For you did not render")

  const failures: string[] = []
  for (let i = 0; i < orders.length; i += 10) {
    await Promise.all(orders.slice(i, i + 10).map(async ({ reference }) => {
      try {
        const html = await get(base, `/orders/${reference}`)
        if (!html.includes(reference) || !html.includes("Timeline")) failures.push(`${reference}: page is missing its reference or timeline`)
      } catch (error) {
        failures.push(`${reference}: ${error instanceof Error ? error.message : error}`)
      }
    }))
  }
  if (failures.length) throw new Error(`Order pages failed:\n${failures.join("\n")}`)

  const byReference = await (await fetch(`${base}/api/search?q=CD-420322`)).json() as { hits: { reference: string }[] }
  if (byReference.hits[0]?.reference !== "CD-420322") throw new Error("Search by reference did not return CD-420322 first")
  const byMessage = await (await fetch(`${base}/api/search?q=roadside`)).json() as { hits: { reference: string; snippet: string | null }[] }
  if (!byMessage.hits.some((hit) => hit.reference === "CD-420322" && hit.snippet)) throw new Error("Search by message text did not find CD-420322")
  await get(base, "/orders?q=Bentley")

  console.log(`Smoke check passed: For you, ${orders.length} order pages, search by reference and by message text.`)
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
