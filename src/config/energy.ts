/**
 * Rough, configurable energy estimator for LLM calls (in gCO₂e).
 *
 * NOTE ON ACCURACY:
 * There is no single “true” gCO₂e-per-token. It varies by:
 * - Model architecture/size & backend optimizations
 * - Hardware & utilization (GPU vs TPU, batch size, throughput)
 * - Datacenter PUE (Power Usage Effectiveness)
 * - Grid carbon intensity (gCO₂/kWh), which varies by region/time
 *
 * This module uses model-specific *placeholders* (Joules/token) with ENV overrides.
 * Treat these as starting points you can calibrate with telemetry.
 *
 * HOW IT WORKS:
 * 1) Determine J/token for prompt vs completion tokens by model (or defaults).
 * 2) Compute Joules = Jpt_prompt*prompt_tokens + Jpt_completion*completion_tokens
 * 3) kWh = Joules / 3,600,000
 * 4) gCO₂e = kWh * GRID_GCO2_PER_KWH * PUE
 *
 * ENV OVERRIDES (examples):
 *  - ENERGY_PUE=1.16                    // hard override; if set, wins over provider/geo defaults
 *  - ENERGY_PROVIDER=AZURE|AWS|GCP|OTHER
 *  - ENERGY_AZURE_GEO=US_VA|US_WY|IE|NL|SG|GLOBAL   // optional hint if provider=AZURE
 *  - ENERGY_GRID_REGION=US|EU|GLOBAL     // used if ENERGY_GRID_GCO2_PER_KWH is not set
 *  - ENERGY_GRID_GCO2_PER_KWH=350
 *  - ENERGY_JPT_PROMPT_DEFAULT=1.00
 *  - ENERGY_JPT_COMPLETION_DEFAULT=2.00
 *  - ENERGY_JPT_PROMPT__GPT_5=0.60
 *  - ENERGY_JPT_COMPLETION__GPT_5=1.40
 *  - ENERGY_JPT_PROMPT__GPT_4O=1.00
 *  - ENERGY_JPT_COMPLETION__GPT_4O=2.20
 *  - ENERGY_JPT_PROMPT__GPT_5_MINI=0.30
 *  - ENERGY_JPT_COMPLETION__GPT_5_MINI=0.60
 *  - ENERGY_JPT_PROMPT__GPT_4O_MINI=0.35
 *  - ENERGY_JPT_COMPLETION__GPT_4O_MINI=0.70
 */

function toInt(v: any): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null
}

type Factors = {
  promptJpt: number // Joules per prompt token (prefill)
  completionJpt: number // Joules per completion token (decode)
}

function numFromEnv(name: string, def: number): number {
  const v = process.env[name]
  if (v == null || v === '') return def
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

function strFromEnv(name: string, def: string): string {
  const v = process.env[name]
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : def
}

// --- Baseline defaults (grounded mid-cases; override with ENV) ---
const DEFAULT_PROMPT_JPT = numFromEnv('ENERGY_JPT_PROMPT_DEFAULT', 1.0)
const DEFAULT_COMPLETION_JPT = numFromEnv('ENERGY_JPT_COMPLETION_DEFAULT', 2.0)

// --- Model-specific defaults (tune with real telemetry) ---
// Keys are normalized (uppercased, non-alphanumeric -> underscores).
const MODEL_DEFAULTS: Record<string, Factors> = {
  // GPT‑5 class (Blackwell/B200-era): ~1.6× better perf/W than H100 mid-case
  GPT_5: {
    promptJpt: numFromEnv('ENERGY_JPT_PROMPT__GPT_5', 0.6),
    completionJpt: numFromEnv('ENERGY_JPT_COMPLETION__GPT_5', 1.4),
  },

  // GPT‑4‑class (H100-era)
  GPT_4O: {
    promptJpt: numFromEnv('ENERGY_JPT_PROMPT__GPT_4O', 1.0),
    completionJpt: numFromEnv('ENERGY_JPT_COMPLETION__GPT_4O', 2.2),
  },

  // Minis (~7–12B)
  GPT_5_MINI: {
    promptJpt: numFromEnv('ENERGY_JPT_PROMPT__GPT_5_MINI', 0.3),
    completionJpt: numFromEnv('ENERGY_JPT_COMPLETION__GPT_5_MINI', 0.6),
  },

  GPT_4O_MINI: {
    promptJpt: numFromEnv('ENERGY_JPT_PROMPT__GPT_4O_MINI', 0.35),
    completionJpt: numFromEnv('ENERGY_JPT_COMPLETION__GPT_4O_MINI', 0.7),
  },
}

function normalizeModelKey(model: string): string {
  return (model || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

function factorsForModel(model: string): Factors {
  const key = normalizeModelKey(model || process.env.OPENAI_MODEL || '')
  if (key && MODEL_DEFAULTS[key]) return MODEL_DEFAULTS[key]
  return {
    promptJpt: DEFAULT_PROMPT_JPT,
    completionJpt: DEFAULT_COMPLETION_JPT,
  }
}

// ---------------- PUE selection ----------------
// If ENERGY_PUE is set, it overrides everything.
// Otherwise pick by provider, with Azure geography hint.
const PROVIDER_PUE_DEFAULTS = {
  AZURE: numFromEnv('ENERGY_PUE__AZURE', 1.16), // Microsoft FY23 global
  AWS: numFromEnv('ENERGY_PUE__AWS', 1.15),
  GCP: numFromEnv('ENERGY_PUE__GCP', 1.09),
  DEFAULT: numFromEnv('ENERGY_PUE', 1.2), // generic fallback
} as const

// A few Azure geography examples (override any via ENERGY_PUE__AZURE_<KEY> if you know the site)
const AZURE_PUE_BY_GEO: Record<string, number> = {
  GLOBAL: numFromEnv('ENERGY_PUE__AZURE_GLOBAL', PROVIDER_PUE_DEFAULTS.AZURE),
  US_WY: numFromEnv('ENERGY_PUE__AZURE_US_WY', 1.11),
  US_VA: numFromEnv('ENERGY_PUE__AZURE_US_VA', 1.14),
  US_IL: numFromEnv('ENERGY_PUE__AZURE_US_IL', 1.35),
  US_TX: numFromEnv('ENERGY_PUE__AZURE_US_TX', 1.28),
  US_WA: numFromEnv('ENERGY_PUE__AZURE_US_WA', 1.15),
  IE: numFromEnv('ENERGY_PUE__AZURE_IE', 1.19),
  NL: numFromEnv('ENERGY_PUE__AZURE_NL', 1.14),
  SE: numFromEnv('ENERGY_PUE__AZURE_SE', 1.16),
  SG: numFromEnv('ENERGY_PUE__AZURE_SG', 1.34),
}

function pickPUE(): number {
  // Hard override wins
  const hard = process.env.ENERGY_PUE
  if (hard != null && hard !== '') {
    const n = Number(hard)
    if (Number.isFinite(n)) return n
  }

  const provider = strFromEnv('ENERGY_PROVIDER', 'AZURE').toUpperCase()
  if (provider === 'AZURE') {
    const geo = normalizeModelKey(strFromEnv('ENERGY_AZURE_GEO', 'GLOBAL'))
    return AZURE_PUE_BY_GEO[geo] ?? AZURE_PUE_BY_GEO.GLOBAL
  }
  if (provider === 'AWS') return PROVIDER_PUE_DEFAULTS.AWS
  if (provider === 'GCP') return PROVIDER_PUE_DEFAULTS.GCP
  return PROVIDER_PUE_DEFAULTS.DEFAULT
}

// ---------------- Grid intensity selection (gCO₂/kWh) ----------------
const GRID_DEFAULTS = {
  US: numFromEnv('ENERGY_GRID_GCO2_PER_KWH__US', 384), // recent US avg
  EU: numFromEnv('ENERGY_GRID_GCO2_PER_KWH__EU', 244), // recent EU avg
  GLOBAL: numFromEnv('ENERGY_GRID_GCO2_PER_KWH__GLOBAL', 480), // global avg
}

function pickGridGco2PerKwh(): number {
  const hard = process.env.ENERGY_GRID_GCO2_PER_KWH
  if (hard != null && hard !== '') {
    const n = Number(hard)
    if (Number.isFinite(n)) return n
  }
  const region = strFromEnv('ENERGY_GRID_REGION', 'GLOBAL').toUpperCase()
  if (region === 'US') return GRID_DEFAULTS.US
  if (region === 'EU') return GRID_DEFAULTS.EU
  return GRID_DEFAULTS.GLOBAL
}

/**
 * Public API (do not change signature): Estimate emissions in gCO₂e for a single LLM call.
 *
 * @param usage - An object with token counts (any of):
 *   - prompt_tokens / input_tokens
 *   - completion_tokens / output_tokens
 *   - total_tokens (will be split 50/50 if prompt/completion missing)
 *   - model?  (optional; if omitted we try OPENAI_MODEL env var)
 * @param modelOverride - optional model name (wins over usage.model)
 * @returns number|null - gCO₂e rounded to 2 decimals, or null if inputs missing
 */
export function estimateEnergyGCO2e(
  usage: any,
  modelOverride?: string,
): number | null {
  if (!usage) return null

  const model = modelOverride || usage.model || process.env.OPENAI_MODEL || ''
  const { promptJpt, completionJpt } = factorsForModel(model)

  // Gather tokens with graceful fallback
  let pt = toInt(usage.prompt_tokens ?? usage.input_tokens)
  let ct = toInt(usage.completion_tokens ?? usage.output_tokens)

  if ((pt == null || ct == null) && usage.total_tokens != null) {
    // Split 50/50 if only total is provided (very rough)
    const tot = toInt(usage.total_tokens) ?? 0
    pt = pt ?? Math.floor(tot / 2)
    ct = ct ?? tot - pt
  }

  if (pt == null && ct == null) return null

  const promptTokens = pt ?? 0
  const completionTokens = ct ?? 0

  // Energy in Joules
  const joules = promptTokens * promptJpt + completionTokens * completionJpt

  // Convert to kWh and multiply by PUE & grid factor
  const kWh = joules / 3_600_000
  const PUE = pickPUE()
  const GRID_GCO2_PER_KWH = pickGridGco2PerKwh()
  const gCO2e = kWh * PUE * GRID_GCO2_PER_KWH

  return Number.isFinite(gCO2e) ? +gCO2e.toFixed(2) : null
}
