type Price = { inM: number; outM: number } // $ per 1M tokens
const DEFAULT_MODEL = 'openai/gpt-4o-mini'
export const MODEL_PRICING: Record<string, Price> = {
  'openai/gpt-4o-mini': { inM: 0.15, outM: 0.6 },
  'openai/gpt-4o': { inM: 2.5, outM: 10.0 },
  'openai/gpt-5-mini': { inM: 0.25, outM: 2.0 },
  'openai/gpt-5-nano': { inM: 0.05, outM: 0.4 },
}

export function estimateCostUSD(usage: any): number | null {
  if (!usage) return null
  const model = String(usage.model ?? DEFAULT_MODEL)
  const price = MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_MODEL]
  const inTok = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0)
  const outTok = Number(usage.completion_tokens ?? usage.output_tokens ?? 0)
  if (!inTok && !outTok) return null
  return +(
    (inTok / 1_000_000) * price.inM +
    (outTok / 1_000_000) * price.outM
  ).toFixed(6)
}
