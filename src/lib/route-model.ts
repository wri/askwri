// The per-request model override exists so `evaluation/route-sweep/` can compare two
// models on one route; it is refused whenever EVAL_MODEL_OVERRIDE_TOKEN is unset or the
// request's x-eval-token does not match it, so production cannot be swept by accident.
// Which request parameters the resolved model takes is decided by
// `requestProfile`, not by the name.
export type RouteProvenance = {
  model: string
  produced: boolean
  fallback_reason?: string
  sanitized?: boolean
}

export function resolveRouteModel(
  req: Request,
  body: unknown,
  fallback: string,
): { ok: true; model: string } | { ok: false; error: string } {
  const requested = (body as { model?: unknown } | null | undefined)?.model
  const model = typeof requested === 'string' ? requested.trim() : ''

  if (!model) return { ok: true, model: fallback }

  // Read at call time, not at import: tests set the variable per test.
  const token = process.env.EVAL_MODEL_OVERRIDE_TOKEN
  if (!token) return { ok: false, error: 'model override not enabled' }
  if (req.headers.get('x-eval-token') !== token) {
    return { ok: false, error: 'invalid eval token' }
  }

  return { ok: true, model }
}
