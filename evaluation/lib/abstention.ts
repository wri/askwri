/**
 * Abstention scoring for negative-polarity eval cases (issue #354).
 *
 * The shipped abstention contract (P3 slice 6, PRs #379–#382) is the
 * off-topic signal: the LLM sidecar extracts the query's core topic, checks
 * it against the corpus vocabulary, and the gateway surfaces
 * `likely_off_topic` on the response. The UI renders the "nothing relevant"
 * banner and keeps the user in control — documents may still be returned
 * underneath the banner, by design. A zero-doc result (the cite floor
 * dropping everything below it) also abstains.
 */

/**
 * A negative case abstains when the target returns nothing OR the off-topic
 * flag fires. Docs under the flag still count as abstained — that is the
 * contract, not a loophole.
 */
export function isAbstained(
  retrievedCount: number,
  likelyOffTopic: boolean,
): boolean {
  return retrievedCount === 0 || likelyOffTopic === true
}

/**
 * A positive case the off-topic flag fired on: a false abstention. Users
 * would see the "nothing relevant" banner on a query the corpus answers.
 */
export function isFalseAbstention(
  polarity: 'positive' | 'negative',
  likelyOffTopic: boolean,
): boolean {
  return polarity === 'positive' && likelyOffTopic === true
}
