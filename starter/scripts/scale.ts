// npm run seed:scale            add 900 synthetic quiet orders (CD-430001 …), so the app runs with 1,000 orders
// npm run seed:scale -- --off   remove them again (the dataset's 100 orders are untouched)
// npm run seed:scale -- --dry   list which quiet orders would be copied, and why the others are left out
// Run after npm run setup: copies are made from the seeded orders and get their timeline built like any order.

import "dotenv/config"
import { closeDb } from "@/lib/db"
import { addScaleOrders, removeScaleOrders, scaleState, scaleTemplates } from "@/lib/scale"

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--dry")) {
    const { templates, skipped } = await scaleTemplates()
    console.log(`${templates.length} quiet orders can be copied: ${templates.map((file) => file.order.reference).join(", ")}`)
    for (const item of skipped) console.log(`  left out ${item.reference}: ${item.why}`)
    return
  }
  if (args.includes("--off")) {
    const { removed, ms } = await removeScaleOrders()
    console.log(removed ? `Removed ${removed} synthetic orders in ${ms} ms.` : "Scale mode was off: no synthetic orders.")
  } else {
    const result = await addScaleOrders(undefined, console.log)
    console.log(`Added ${result.added} synthetic orders from ${result.templates} quiet orders in ${result.ms} ms.`)
  }
  const state = await scaleState()
  console.log(`Orders now: ${state.total} (${state.synthetic} synthetic).`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDb)
