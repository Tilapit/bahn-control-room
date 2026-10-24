// npm run disruptions:seed: the mocked disruption feed (three fictional notices). Part of npm run setup.

import "dotenv/config"
import { closeDb } from "@/lib/db"
import { seedDisruptions } from "@/lib/disruptions"

seedDisruptions().then((n) => console.log(`${n} fictional disruption notices in the feed (the Lille protest is published by the Demo page).`))
  .catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDb)
