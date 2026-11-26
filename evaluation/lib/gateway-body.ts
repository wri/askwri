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

/** One explicit facet constraint, in the search service's own request shape. */
export interface FacetInput {
  facet: string
  value: string
}

/**
 * The per-case fixed facets named by `EVAL_FACETS`: a JSON object mapping
 * case id → array of `{facet, value}`. Parsed at most once per distinct value
 * (a change in the env var reparses) so a malformed manifest throws before
 * any request. Unset means the lever is off — every case gets no facets.
 */
export function facetsManifest(): Record<string, FacetInput[]> {
  const raw = process.env.EVAL_FACETS
  if (manifestCache && manifestCache.raw === raw) return manifestCache.manifest
  const manifest: Record<string, FacetInput[]> = {}
  if (raw !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e: any) {
      throw new Error(
        `EVAL_FACETS is not valid JSON (${e.message}) — a malformed manifest must fail before any request`,
      )
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        'EVAL_FACETS must be a JSON object mapping case id → [{facet, value}]',
      )
    }
    for (const [caseId, entries] of Object.entries(parsed)) {
      if (!Array.isArray(entries)) {
        throw new Error(
          `EVAL_FACETS["${caseId}"] must be an array of {facet, value} objects`,
        )
      }
      for (const entry of entries) {
        if (
          typeof entry !== 'object' ||
          entry === null ||
          typeof (entry as any).facet !== 'string' ||
          typeof (entry as any).value !== 'string'
        ) {
          throw new Error(
            `EVAL_FACETS["${caseId}"] has an entry that is not a {facet, value} object with string values`,
          )
        }
      }
      manifest[caseId] = entries as FacetInput[]
    }
  }
  manifestCache = { raw, manifest }
  return manifest
}

let manifestCache: {
  raw: string | undefined
  manifest: Record<string, FacetInput[]>
} | null = null

/** The facets the manifest names for one case — `[]` when it names none. */
export function facetsForCase(caseId: string): FacetInput[] {
  return facetsManifest()[caseId] ?? []
}

/**
 * Fails before any request when a manifest key names no case id in the set
 * passed in. `main()` passes the union across every evalset being run, so a
 * partial manifest is legal — the default multi-set run must not abort on the
 * first set that lacks its keys.
 */
export function validateFacetCaseIds(knownCaseIds: Set<string>): void {
  const unknown = Object.keys(facetsManifest()).filter(
    (key) => !knownCaseIds.has(key),
  )
  if (unknown.length > 0) {
    throw new Error(
      `EVAL_FACETS names case ids not in the evalsets being run: ${unknown.join(', ')}`,
    )
  }
}

export function gatewayBody(
  query: string,
  mode: 'cite' | 'answer',
  facets?: FacetInput[],
): Record<string, unknown> {
  const body: Record<string, unknown> = { query, mode }
  // `expansion: false` is the search service's flag-off guard
  // (understanding_active in app/understanding.py): the whole understanding and
  // expansion path, lanes and LLM sidecar alike, is byte-identical to running
  // with the flags off — which is also the path production runs today.
  if (expansionArm() === 'off') body.expansion = false
  // The fixed-facet arm (#450): explicit facets apply with understanding off,
  // and `return_intermediate_results` is what populates debug.excluded_doc_ids —
  // the signal that says whether the facet, not retrieval, removed a doc.
  // Only when facets are present: a plain run still sends no retrieval params.
  if (facets && facets.length > 0) {
    body.facets = facets
    body.return_intermediate_results = true
  }
  return body
}
