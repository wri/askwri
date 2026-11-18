// Everything a model name decides for POST /api/alignment, derived at call time
// from the model actually being asked.
//
// It lives in `lib/` rather than in the route module because Next's generated
// per-route type guard permits only route exports (`GET`, `POST`, `runtime`, …)
// from a `route.ts`, so a helper exported there fails the production build.
//
// The token caps and temperature come from `requestProfile`; this file owns the
// timeout BASES, which the route then scales per request and clamps. A model
// without the gpt-5 capability must get the shorter ladder, or the provider
// 400s and the route answers canned text as if nothing were wrong.
import { modelCapability } from '@/lib/request-profile'

export function resolveAlignmentConfig(model: string) {
  // The ladder follows the model this call will actually reach. After a flip the
  // assignment IS the candidate, so a pre-flip sweep measures the candidate under
  // the deadline it will run with — deriving it from the incumbent instead biased
  // every candidate gate toward the slower ladder (whole-branch review, finding 7).
  const gpt5Class = modelCapability(model).gpt5Class

  // Timeout bases (scaled per request and clamped in the route) - GPT-5
  // needs longer timeouts.
  const defaultMainMs = gpt5Class ? 40000 : 20000
  const defaultRepairMs = gpt5Class ? 25000 : 12000
  const mainMs = Number(process.env.ALIGNMENT_TIMEOUT_MS_MAIN ?? defaultMainMs)
  const repairMs = Number(
    process.env.ALIGNMENT_TIMEOUT_MS_REPAIR ?? defaultRepairMs,
  )

  return { model, gpt5Class, mainMs, repairMs }
}
