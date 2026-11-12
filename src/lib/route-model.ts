// The per-request model override exists so `evaluation/route-sweep/` can compare two
// models on one route; it is refused whenever EVAL_MODEL_OVERRIDE_TOKEN is unset or the
// request's x-eval-token does not match it, so production cannot be swept by accident.
export type RouteProvenance = {
  model: string
  produced: boolean
  fallback_reason?: string
  sanitized?: boolean
}

const GPT5 = /^gpt-5/i

export function resolveRouteModel(
  req: Request,
  body: unknown,
  fallback: string,
): { ok: true; model: string; isGpt5: boolean } | { ok: false; error: string } {
  const requested = (body as { model?: unknown } | null | undefined)?.model
  const model = typeof requested === 'string' ? requested.trim() : ''

  if (!model) return { ok: true, model: fallback, isGpt5: GPT5.test(fallback) }

  // Read at call time, not at import: tests set the variable per test.
  const token = process.env.EVAL_MODEL_OVERRIDE_TOKEN
  if (!token) return { ok: false, error: 'model override not enabled' }
  if (req.headers.get('x-eval-token') !== token) {
    return { ok: false, error: 'invalid eval token' }
  }

  return { ok: true, model, isGpt5: GPT5.test(model) }
}
