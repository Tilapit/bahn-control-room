// npm run api:check: is the Anthropic API reachable with this key, and does it have credit? One tiny Haiku call.

import "dotenv/config"
import Anthropic from "@anthropic-ai/sdk"
import { hasApiKey } from "@/lib/agents/llm"
import { MODELS } from "@/lib/models"

async function main() {
  if (!hasApiKey()) { console.log("No ANTHROPIC_API_KEY: the app shows recorded agent runs, and the Demo page replays recorded scenarios."); return }
  try {
    await new Anthropic({ maxRetries: 0 }).messages.create({ model: MODELS.haiku, max_tokens: 5, messages: [{ role: "user", content: "ok" }] })
    console.log("The API key works: agents can run live.")
  } catch (error) {
    console.log(`The API key does not work right now: ${error instanceof Error ? error.message.replace(/\{.*"message":"([^"]+)".*\}/, "$1") : error}`)
    process.exitCode = 1
  }
}

main()
