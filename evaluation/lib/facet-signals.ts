/**
 * The facet-arm signals the search service reports in `debug` (#522).
 *
 * #522 chooses its arm by SERVICE ENV (`FACET_MODE`), not by the request, so
 * the run artifact — not the operator's memory — has to say which arm answered.
 * `facet_mode` is that evidence; `boosted_doc_ids` is what the boost actually
 * rewarded, which is the only way to tell "shaping lost" from "the weight never
 * reached those documents".
 */

export type FacetMode = 'filter' | 'boost'

export interface FacetSignals {
  /** The arm the target ran this request in; null when it predates the signal. */
  facetMode: FacetMode | null
  /** Doc ids the target excluded (its `debug.excluded_doc_ids`). */
  excludedDocIds: string[] | null
  /** Doc ids the boost rewarded (its `debug.boosted_doc_ids`); null in the filter arm. */
  boostedDocIds: string[] | null
}

export function facetSignals(debug: any): FacetSignals {
  const mode = debug?.facet_mode
  return {
    // An unrecognised mode is reported as unknown, never as an arm: a
    // mislabelled run would claim a comparison that never happened.
    facetMode: mode === 'filter' || mode === 'boost' ? mode : null,
    excludedDocIds: debug?.excluded_doc_ids ?? null,
    boostedDocIds: debug?.boosted_doc_ids ?? null,
  }
}
