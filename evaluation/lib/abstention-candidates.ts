/**
 * TS mirror of the search service's core-topic candidate policy
 * (search-service/app/main.py, core_topic_in_corpus): the full core_topic,
 * then each contiguous 2-gram. Single words are NOT candidates for
 * multi-word topics — they are generic corpus noise that rescues negatives
 * (d8/d9). The full clause is tried first so an exact title hit wins.
 *
 * The Python side stays authoritative; this mirror exists so the blast-radius
 * tool (evaluation/diagnostics/abstention-blast-radius.ts) can evaluate
 * policy changes against every eval case BEFORE any deploy. Keep the two in
 * sync — the service's debug.abstention.matched_term is the cross-check.
 *
 * Candidate terms are lowercased here because the snapshot surface is stored
 * lowercased; the service's ILIKE is case-insensitive, so the semantics match.
 */

export type CandidatePolicy = 'current' | 'stopword-filtered'

/**
 * Framing words that carry no topical identity inside a candidate. Under the
 * 'stopword-filtered' policy, any candidate containing one of these is
 * dropped: 'in cities' is a title-collision accident, not a topic.
 *
 * v0 list — derived from the framing fragments observed in drifted
 * extractions (issue #402). Extend only with a blast-radius table attached.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'or', 'in', 'and', 'of', 'to', 'at', 'for', 'with', 'on', 'by',
  'the', 'a', 'an', 'vs', 'versus',
])

/**
 * The candidate terms the abstain check would try, under a policy.
 * 'current' mirrors the deployed service exactly; 'stopword-filtered' is the
 * first tuning candidate (measured 2026-09-09: fixes d9, flips q5/q6 — see
 * the blast-radius table before shipping anything).
 */
export function candidatesFor(
  coreTopic: string,
  policy: CandidatePolicy = 'current',
): string[] {
  const core = coreTopic.trim().toLowerCase()
  if (!core) return []
  const words = core.split(/\s+/)
  const candidates = [core]
  for (let i = 0; i + 1 < words.length; i++) {
    candidates.push(`${words[i]} ${words[i + 1]}`)
  }
  const filtered =
    policy === 'stopword-filtered'
      ? candidates.filter(
          (c) => !c.split(' ').some((w) => STOP_WORDS.has(w)),
        )
      : candidates
  // Dedupe is a harmless divergence from Python (a 2-word topic generates
  // its own full phrase twice); it changes no match outcomes.
  return [...new Set(filtered)]
}
