import { calculateChunkMetrics, assertChunkMetricsValid } from './metrics'

// Regression tests for the adjacent-tolerance double-count bug: a single
// retrieved chunk could be counted more than once (as an exact match AND as an
// adjacent-credit source, or as the adjacent source for two expected chunks),
// pushing precision_with_adjacent above 1.0 (observed on ans_008 / ans_009).

describe('calculateChunkMetrics adjacent-tolerance credit', () => {
  test('a retrieved chunk used for an exact match is not reused for adjacent credit', () => {
    // Retrieved chunk_4 exactly matches expected chunk_4. It must NOT also be
    // spent as the ±1 adjacent source for expected chunk_5.
    const expected = [
      { chunk_id: 'doc_chunk_4', doc_id: 'doc' },
      { chunk_id: 'doc_chunk_5', doc_id: 'doc' },
    ]
    const retrieved = [{ chunk_id: 'doc_chunk_4', doc_id: 'doc' }]

    const m = calculateChunkMetrics(expected, retrieved)

    expect(m.precision_with_adjacent).toBeLessThanOrEqual(1)
    expect(m.exact_matches).toEqual(['doc_chunk_4'])
    expect(m.adjacent_matches).toEqual([])
    expect(m.precision_with_adjacent).toBe(1) // 1 credit / 1 retrieved
  })

  test('a single retrieved chunk provides adjacent credit to at most one expected chunk', () => {
    // Retrieved chunk_5 is ±1 to BOTH expected chunk_4 and chunk_6, but it is
    // one physical chunk and can only supply one 0.5 credit.
    const expected = [
      { chunk_id: 'doc_chunk_4', doc_id: 'doc' },
      { chunk_id: 'doc_chunk_6', doc_id: 'doc' },
    ]
    const retrieved = [{ chunk_id: 'doc_chunk_5', doc_id: 'doc' }]

    const m = calculateChunkMetrics(expected, retrieved)

    expect(m.precision_with_adjacent).toBeLessThanOrEqual(1)
    expect(m.adjacent_matches.length).toBe(1) // only one of the two, not both
    expect(m.precision_with_adjacent).toBe(0.5) // 0.5 credit / 1 retrieved
  })

  test('adjacent credit is still awarded from a distinct, unconsumed retrieved chunk', () => {
    // Guard against over-correction: legitimate near-miss credit must survive.
    const expected = [{ chunk_id: 'doc_chunk_5', doc_id: 'doc' }]
    const retrieved = [{ chunk_id: 'doc_chunk_4', doc_id: 'doc' }]

    const m = calculateChunkMetrics(expected, retrieved)

    expect(m.adjacent_matches).toEqual(['doc_chunk_5'])
    expect(m.recall_with_adjacent).toBe(0.5)
    expect(m.precision_with_adjacent).toBe(0.5)
  })
})

describe('assertChunkMetricsValid', () => {
  test('throws when precision_with_adjacent exceeds 1 (regression tripwire)', () => {
    const bad = {
      exact_matches: [],
      adjacent_matches: [],
      precision: 1,
      recall: 1,
      f1: 1,
      precision_with_adjacent: 1.13,
      recall_with_adjacent: 1,
      f1_with_adjacent: 1,
    }
    expect(() => assertChunkMetricsValid(bad, 'ans_008')).toThrow(
      /precision_with_adjacent/,
    )
    expect(() => assertChunkMetricsValid(bad, 'ans_008')).toThrow(/ans_008/)
  })

  test('does not throw for a valid result', () => {
    const good = calculateChunkMetrics(
      [{ chunk_id: 'd_chunk_1', doc_id: 'd' }],
      [{ chunk_id: 'd_chunk_1', doc_id: 'd' }],
    )
    expect(() => assertChunkMetricsValid(good, 'ok')).not.toThrow()
  })
})
