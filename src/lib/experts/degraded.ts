// Experts mode degradation vocabulary (spec §9). Shared by the API route —
// which decides whether to substitute doc-derived topics for the tags-derived
// ones — and the page, which must tell the reader that the strengths it is
// showing are NOT query→tag cosines. One definition so the two cannot drift.

/** The topic lane is genuinely unavailable: the whole /tags/nearby call failed,
 *  or the service reported the topic facet degraded (no `tag_embeddings`
 *  coverage, or the query for it raised). A geography-only degradation leaves
 *  the topic cosines real, so it is false. */
export const TOPIC_DEGRADED = 'tags_nearby:topic'

/** The topic lane answered correctly and simply found nothing: no tag cleared
 *  `topic_sense_min_cosine`. The search service deliberately does NOT call this
 *  degraded (see test_covered_facet_with_no_match_is_not_degraded), and neither
 *  should the UI — but the page still falls back to document-derived topics, so
 *  the substitution has to be visible. Separate token, separate wording. */
export const TOPIC_NO_MATCH = 'tags_nearby:topic_no_match'

/** /query itself failed. */
export const QUERY_DEGRADED = 'query'

export function isTopicDegraded(degraded: string[]): boolean {
  return degraded.includes('tags_nearby') || degraded.includes(TOPIC_DEGRADED)
}

/** True whenever `understanding.matched_topics` holds document-derived
 *  strengths rather than query→tag cosines — for EITHER reason above. This is
 *  the predicate every display surface wants: the numbers are not cosines and
 *  must not be shown as if they were. */
export function isTopicDerived(degraded: string[]): boolean {
  return isTopicDegraded(degraded) || degraded.includes(TOPIC_NO_MATCH)
}
