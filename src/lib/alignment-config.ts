// Everything a model name decides for POST /api/alignment, derived at call time
// from the model actually being asked.
//
// It lives in `lib/` rather than in the route module because Next's generated
// per-route type guard permits only route exports (`GET`, `POST`, `runtime`, …)
// from a `route.ts`, so a helper exported there fails the production build.
//
// A candidate without a `gpt-5` prefix must get `max_tokens` + `temperature` and
// the shorter timeout ladder, or the provider 400s and the route answers canned
// text as if nothing were wrong.
import {
  ALIGNMENT_MAX_TOKENS as CFG_MAX_TOKENS,
  ALIGNMENT_TEMPERATURE as CFG_TEMPERATURE,
} from '@/config/alignment'

export function resolveAlignmentConfig(model: string) {
  const isGpt5 = /^gpt-5/i.test(model)

  // Timeouts (scaled per request; capped) - GPT-5 needs longer timeouts
  const defaultMainMs = isGpt5 ? 40000 : 20000
  const defaultRepairMs = isGpt5 ? 25000 : 12000
  const mainMs = Number(process.env.ALIGNMENT_TIMEOUT_MS_MAIN ?? defaultMainMs)
  const repairMs = Number(
    process.env.ALIGNMENT_TIMEOUT_MS_REPAIR ?? defaultRepairMs,
  )

  // Token caps - increased for GPT-5 reasoning token usage
  const envMax = Number(process.env.OPENAI_MAX_TOKENS ?? CFG_MAX_TOKENS ?? 1500)
  const mainMax = isGpt5 ? 4000 : Math.max(1000, Math.min(1500, envMax))
  const repairMax = isGpt5 ? 5000 : Math.min(mainMax + 500, 2000)

  // Temperature (route will omit for GPT-5 models)
  const temperature = Number(
    process.env.OPENAI_TEMPERATURE ?? CFG_TEMPERATURE ?? 0.7,
  )

  return { model, isGpt5, mainMs, repairMs, mainMax, repairMax, temperature }
}
