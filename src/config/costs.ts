type Price = { inK: number; outK: number }; // $ per 1K tokens
// Adjust this to your actual pipeline model. Defaults are placeholders.
const DEFAULT_MODEL = "openai/gpt-4o-mini";
export const MODEL_PRICING: Record<string, Price> = {
  "openai/gpt-4o-mini": { inK: 0.15, outK: 0.60 }, // example only
  "openai/gpt-4o":      { inK: 2.50, outK: 10.00 }, // example only
  "openai/gpt-5-mini":  { inK: 0.25, outK: 2.00},
  "openai/gpt-5-nano":  { inK: 0.05, outK: 0.40}, // alignment model
};

export function estimateCostUSD(usage: any): number | null {
  if (!usage) return null;
  const model = String(usage.model ?? DEFAULT_MODEL);
  const price = MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_MODEL];
  const inTok = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outTok = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  if (!inTok && !outTok) return null;
  return +( (inTok/1000)*price.inK + (outTok/1000)*price.outK ).toFixed(4);
}

