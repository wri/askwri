/**
 * Mechanical checks: the failure modes a model swap actually produces, and none
 * of them need a human to spot. Every failure here is a way the sweep could
 * otherwise report agreement where there was none — a route that answered from
 * a canned fallback, a model that is not the one that was asked for, a route
 * that dropped inputs, or a call made over no documents at all.
 *
 * Nothing here judges quality. It says whether a call is evidence; the readout
 * is what a person compares.
 */
import type { CallResult, RouteName } from './types'

/** One entry per output item, each holding the text that item must contain.
 * Array routes carry one field per item; alignment's single output is its
 * `assessment.insights[]`, so one item holds several strings. */
type Extracted = { items: string[][] } | { missing: string }

/**
 * Reads the route's documented output shape. A shape that is absent entirely is
 * reported rather than treated as zero outputs: the two mean different things
 * (a broken contract vs. a route that answered with nothing).
 */
function extractOutputs(route: RouteName, body: any): Extracted {
  if (!body || typeof body !== 'object') {
    return { missing: 'response body is not an object' }
  }
  switch (route) {
    case 'batch-why': {
      if (!Array.isArray(body.explanations)) {
        return { missing: 'response has no explanations[]' }
      }
      return {
        items: body.explanations.map((e: any) => [String(e?.why ?? '')]),
      }
    }
    case 'batch-relates': {
      if (!Array.isArray(body.results)) {
        return { missing: 'response has no results[]' }
      }
      return { items: body.results.map((r: any) => [String(r?.relates ?? '')]) }
    }
    case 'alignment': {
      const insights = body.assessment?.insights
      if (!Array.isArray(insights)) {
        return { missing: 'response has no assessment.insights[]' }
      }
      return { items: [insights.map((t: any) => String(t ?? ''))] }
    }
    case 'translate': {
      if (typeof body.translation !== 'string') {
        return { missing: 'response has no translation' }
      }
      return { items: [[body.translation]] }
    }
  }
}

/**
 * How many outputs the response had to contain: the payload's array length for
 * the array routes, 1 for the single-output ones. Read from the request, never
 * from the response — a response cannot say how many inputs it dropped.
 *
 * An unreadable array counts as 0, which `checkCall` reports as a failure; the
 * alternative would be to skip the length check on exactly the malformed
 * payloads it exists to catch.
 *
 * Exported because `checkCall` has two callers — the readout and the CLI's
 * console summary — and neither may derive this itself: a second spelling that
 * drifted could print `checks: 0 of N calls failed` above a readout that marks
 * failures, which is the clean-looking run this whole tool exists to prevent.
 */
export function inputCount(route: RouteName, request: unknown): number {
  if (route === 'translate' || route === 'alignment') return 1
  const field = route === 'batch-why' ? 'passages' : 'docs'
  const list = (request as Record<string, unknown> | null)?.[field]
  return Array.isArray(list) ? list.length : 0
}

/**
 * Decides whether one recorded call is evidence.
 *
 * `inputCount` is what the response had to contain, from `inputCount` above.
 * Zero is a failure on purpose — a case whose retrieval returned nothing cannot
 * evidence anything about a model, and a check that let it pass would report a
 * clean run over cases that were never run. For the two single-output routes
 * the count can only ever match, which is the point: they answer once, so the
 * failure they can actually have is a missing shape, reported by
 * `extractOutputs`.
 */
export function checkCall(
  r: CallResult,
  expectedModel: string,
  inputCount: number,
): { ok: boolean; failures: string[] } {
  const failures: string[] = []

  if (inputCount === 0) {
    failures.push(
      'case had zero documents, so the response is not evidence of anything',
    )
  }

  // A recorded error short-circuits the rest: an error body has no output to
  // inspect, and reporting its missing fields as further failures would bury
  // the one that explains it.
  if (r.error) {
    failures.push(`call error: ${r.error}`)
    return { ok: false, failures }
  }

  const p = r.provenance
  if (!p) {
    failures.push(
      'response carries no provenance, so the model that wrote it is unknown',
    )
  } else {
    if (p.produced !== true) {
      failures.push(
        'response was not produced by a model' +
          (p.fallback_reason ? ` (fallback_reason: ${p.fallback_reason})` : ''),
      )
    }
    if (p.model !== expectedModel) {
      failures.push(
        `provenance.model is ${p.model}, not the requested ${expectedModel}`,
      )
    }
  }

  const extracted = extractOutputs(r.route, r.response)
  if ('missing' in extracted) {
    failures.push(extracted.missing)
    return { ok: false, failures }
  }

  if (extracted.items.length !== inputCount) {
    failures.push(
      `expected ${inputCount} output(s), got ${extracted.items.length}`,
    )
  }
  extracted.items.forEach((texts, i) => {
    if (!texts.some((t) => t.trim() !== '')) {
      failures.push(`output ${i} is empty text`)
    }
  })

  return { ok: failures.length === 0, failures }
}
