// Model ids and prices, in one place (SPEC 7). Cost is computed in code from the
// usage the API returns; no other module names a model id.

export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
} as const

export type ModelKey = keyof typeof MODELS
export type ModelId = (typeof MODELS)[ModelKey]

/** US dollars per million tokens. Cache writes use the 5-minute TTL (1.25x input). */
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

const PRICES: Record<ModelId, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
}

/** Which model does which job (SPEC 7). */
export const ROLE_MODEL = {
  classifier: MODELS.haiku,
  verifier: MODELS.haiku,
  narrator: MODELS.haiku,
  simulatedParty: MODELS.haiku,
  driverSupport: MODELS.sonnet,
  investigator: MODELS.sonnet,
  /** Safety, a cost above €500, or evidence that conflicts. */
  investigatorSenior: MODELS.opus,
} as const

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** The API's usage object, in our shape. */
export function usageOf(usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null | undefined): Usage {
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
  }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }
}

/** Dollars for one call. A model the table does not know (a server-side fallback) is priced as Opus, the most expensive we use. */
export function costUsd(model: string, usage: Usage): number {
  const price = PRICES[model as ModelId] ?? PRICES[MODELS.opus]
  return (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / 1_000_000
}

/** "Opus", "Sonnet", "Haiku" for screens. */
export function modelName(model: string | null | undefined): string {
  if (!model) return "Code"
  if (model.includes("opus")) return "Opus"
  if (model.includes("sonnet")) return "Sonnet"
  if (model.includes("haiku")) return "Haiku"
  return "Model"
}

export function isModel(model: string, key: ModelKey): boolean {
  return model === MODELS[key]
}
