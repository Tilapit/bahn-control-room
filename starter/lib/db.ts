// The one database client. Server code and the npm scripts both import it, so it
// does not carry a `server-only` guard; client components never import lib/.

import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"

const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL is required. See starter/README.md.")

// Next.js dev reloads modules; keep one pool per process instead of one per reload.
const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres> }
const client = globalForDb.pgClient ?? postgres(url, { max: 5 })
if (process.env.NODE_ENV !== "production") globalForDb.pgClient = client

export const db = drizzle(client, { schema })

/** Scripts call this at the end so the process can exit. */
export async function closeDb(): Promise<void> {
  await client.end()
}
