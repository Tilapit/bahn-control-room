// npm run learning:seed
// The dataset's reviewed agent proposals as past decisions, each with its outcome checked against the snapshot
// (lib/outcomes.ts), plus three rejections of demo history (marked as such) and the playbook suggestions they
// lead to (lib/learning.ts). Idempotent: it replaces the dataset and demo rows and keeps every decision made here.

import "dotenv/config"
import { closeDb } from "@/lib/db"
import { refreshPlaybookSuggestions, seedDemoHistory } from "@/lib/learning"
import { seedDatasetDecisions } from "@/lib/outcomes"

async function main() {
  const result = await seedDatasetDecisions()
  console.log(`Past decisions from the dataset: ${result.rows}, ${result.withOutcome} with an outcome.`)
  console.log(`Demo history: ${await seedDemoHistory()} rejections, marked as demo history.`)
  console.log(`Playbook suggestions drafted: ${await refreshPlaybookSuggestions()}.`)
  await closeDb()
}

main().catch((error) => { console.error(error); process.exit(1) })
