/**
 * The request body the eval harness sends to a target's retrieval gateway.
 *
 * `evaluation/README.md` requires that a plain run sends NO retrieval params —
 * the numbers must reflect what users get. The flag-on vs flag-off comparison
 * (#498) is the one case that has to override the target's own presets, so it
 * asks for that out loud via `EVAL_EXPANSION=off`, and every artifact says
 * which arm it came from.
 */

export type ExpansionArm = 'on' | 'off'

/** The arm named by `EVAL_EXPANSION`. Unset or `on` is the default arm. */
export function expansionArm(): ExpansionArm {
  const raw = process.env.EVAL_EXPANSION
  if (raw === undefined || raw === 'on') return 'on'
  if (raw === 'off') return 'off'
  // A typo here would run the default arm and record it as a comparison.
  throw new Error(
    `EVAL_EXPANSION must be "on" or "off", got "${raw}" — an unrecognised arm would record a default run as a comparison`,
  )
}

export function gatewayBody(
  query: string,
  mode: 'cite' | 'answer',
): Record<string, unknown> {
  const body: Record<string, unknown> = { query, mode }
  // `expansion: false` is the search service's flag-off guard
  // (understanding_active in app/understanding.py): the whole understanding and
  // expansion path, lanes and LLM sidecar alike, is byte-identical to running
  // with the flags off — which is also the path production runs today.
  if (expansionArm() === 'off') body.expansion = false
  return body
}
