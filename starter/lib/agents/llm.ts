// The one Anthropic client, prompt loading, and a helper for single JSON-output
// calls (Classifier, Verifier, Narrator, simulated parties). Tool-use loops live
// in investigator.ts. Model ids come from lib/models.ts only.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import Anthropic from "@anthropic-ai/sdk"
import { costUsd, type Usage, usageOf } from "../models"

let client: Anthropic | null = null

export function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

export function anthropic(): Anthropic {
  if (!hasApiKey()) throw new Error("ANTHROPIC_API_KEY is not set. Agents cannot run; the app shows recorded runs instead.")
  client ??= new Anthropic({ maxRetries: 4 })
  return client
}

const prompts = new Map<string, string>()

/** A system prompt from lib/agents/prompts/<name>.md. Read once per process; never edited at runtime, so the cache prefix stays stable. */
export function prompt(name: string): string {
  const known = prompts.get(name)
  if (known) return known
  const text = readFileSync(join(process.cwd(), "lib", "agents", "prompts", `${name}.md`), "utf8").trim()
  prompts.set(name, text)
  return text
}

export type CallResult<T> = { value: T; usage: Usage; costUsd: number; model: string; raw: string }

/** One call that must answer with JSON matching `schema`. */
export async function callJson<T>(options: {
  model: string
  system: string
  user: string
  schema: Record<string, unknown>
  maxTokens?: number
  effort?: "low" | "medium" | "high"
}): Promise<CallResult<T>> {
  const response = await anthropic().messages.create({
    model: options.model,
    // Thinking counts against max_tokens, so leave room for it.
    max_tokens: options.maxTokens ?? 16000,
    system: [{ type: "text", text: options.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: options.user }],
    output_config: { effort: options.effort ?? "low", format: { type: "json_schema", schema: options.schema } },
  })
  if (response.stop_reason === "refusal") throw new Error(`${options.model} declined the request.`)
  if (response.stop_reason === "max_tokens") throw new Error(`${options.model} ran out of room before finishing its answer.`)
  const raw = response.content.map((block) => block.type === "text" ? block.text : "").join("")
  const usage = usageOf(response.usage)
  return { value: JSON.parse(raw) as T, usage, costUsd: costUsd(response.model, usage), model: response.model, raw }
}

/** One plain-text call (the simulated driver's reply). */
export async function callText(options: { model: string; system: string; user: string; maxTokens?: number }): Promise<CallResult<string>> {
  const response = await anthropic().messages.create({
    model: options.model,
    max_tokens: options.maxTokens ?? 1000,
    system: [{ type: "text", text: options.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: options.user }],
    output_config: { effort: "low" },
  })
  const raw = response.content.map((block) => block.type === "text" ? block.text : "").join("").trim()
  const usage = usageOf(response.usage)
  return { value: raw, usage, costUsd: costUsd(response.model, usage), model: response.model, raw }
}
