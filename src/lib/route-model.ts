// The per-request model override exists so `evaluation/route-sweep/` can compare two
// models on one route; it is refused whenever EVAL_MODEL_OVERRIDE_TOKEN is unset or the
// request's x-eval-token does not match it, so production cannot be swept by accident.
// Which request parameters the resolved model takes is decided by
// `requestProfile`, not by the name.
import { TASK_EFFORT, canRunEffort, type TaskId } from '@/config/models'

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
  /** When given, an override that cannot run this task's effort is refused —
   *  the route is already running, so this is a request-time error (400). */
  task?: TaskId,
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

  if (task) {
    const effort = TASK_EFFORT[task]
    // An unregistered id keeps its documented hole: the eval-only callers send ids
    // the registry does not own, and `canRunEffort` allows those.
    if (!canRunEffort(model, effort)) {
      return {
        ok: false,
        error: `model ${model} cannot run the ${effort} effort this task uses`,
      }
    }
  }

  return { ok: true, model }
}
