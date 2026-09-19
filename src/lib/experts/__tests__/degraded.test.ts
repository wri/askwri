import {
  isTopicDegraded,
  isTopicDerived,
  QUERY_DEGRADED,
  TOPIC_DEGRADED,
  TOPIC_NO_MATCH,
} from '@/lib/experts/degraded'

describe('isTopicDegraded', () => {
  it('is false when nothing degraded', () => {
    expect(isTopicDegraded([])).toBe(false)
  })

  it('is true when the whole /tags/nearby call failed', () => {
    expect(isTopicDegraded(['tags_nearby'])).toBe(true)
  })

  it('is true when only the topic facet degraded', () => {
    expect(isTopicDegraded(['tags_nearby:topic'])).toBe(true)
  })

  it('is FALSE when only the geography facet degraded — topic cosines are real', () => {
    expect(isTopicDegraded(['tags_nearby:geography'])).toBe(false)
  })

  it('ignores an unrelated degradation such as /query', () => {
    expect(isTopicDegraded(['query'])).toBe(false)
  })
})

describe('isTopicDerived', () => {
  // The route falls back to document-derived topics for two different reasons.
  // Both mean "these numbers are not cosines"; only one means "a lane is down".
  it('is true when the lane is down', () => {
    expect(isTopicDerived([TOPIC_DEGRADED])).toBe(true)
    expect(isTopicDerived(['tags_nearby'])).toBe(true)
  })

  it('is true when the lane answered but nothing cleared the threshold', () => {
    expect(isTopicDerived([TOPIC_NO_MATCH])).toBe(true)
  })

  it('separates the two: a no-match is NOT a degradation', () => {
    expect(isTopicDegraded([TOPIC_NO_MATCH])).toBe(false)
  })

  it('is false when nothing happened', () => {
    expect(isTopicDerived([])).toBe(false)
    expect(isTopicDerived([QUERY_DEGRADED])).toBe(false)
  })
})
