// npm run learning:seed
// The dataset's reviewed agent proposals as past decisions, each with its outcome checked against the snapshot
// (lib/outcomes.ts). Idempotent: it replaces the dataset rows and keeps every decision made in the control room.

import "dotenv/config"
import { closeDb } from "@/lib/db"
import { seedDatasetDecisions } from "@/lib/outcomes"

async function main() {
  const result = await seedDatasetDecisions()
  console.log(`Past decisions from the dataset: ${result.rows}, ${result.withOutcome} with an outcome.`)
  await closeDb()
}

main().catch((error) => { console.error(error); process.exit(1) })
