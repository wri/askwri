import {
  averagePrecision,
  calculateChunkMetrics,
  assertChunkMetricsValid,
  docCoverage,
  latencySummary,
} from './metrics'

describe('averagePrecision', () => {
  test('single expected doc at rank 1 scores 1', () => {
    expect(averagePrecision(['a'], ['a', 'x', 'y'])).toBe(1)
  })

  test('single expected doc at rank 3 scores 1/3', () => {
    expect(averagePrecision(['a'], ['x', 'y', 'a'])).toBeCloseTo(1 / 3)
  })

  test('expected doc never retrieved scores 0', () => {
    expect(averagePrecision(['a'], ['x', 'y'])).toBe(0)
  })

  test('empty retrieved list scores 0', () => {
    expect(averagePrecision(['a'], [])).toBe(0)
  })

  test('two expected docs at ranks 1 and 3 score (1/1 + 2/3) / 2', () => {
    expect(averagePrecision(['a', 'b'], ['a', 'x', 'b'])).toBeCloseTo(5 / 6)
  })

  test('one of two expected docs found at rank 2 scores (1/2) / 2', () => {
    expect(averagePrecision(['a', 'b'], ['x', 'a', 'y'])).toBeCloseTo(0.25)
  })

  test('a duplicate retrieved id earns credit only once', () => {
    // Retrieved lists are deduped upstream, but the function must not let a
    // repeat push AP above 1 if that ever regresses.
    expect(averagePrecision(['a'], ['a', 'a'])).toBe(1)
  })
})

// docCoverage exists so attainable recall can never be read alone: a document
// dropped from the corpus raises attainable recall while lowering in_corpus,
// and reporting both side by side makes that trade visible.

describe('docCoverage', () => {
  test('sums expected, in-corpus, and retrieved doc counts across cases', () => {
    const cases = [
      // 3 expected, 1 absent from the corpus, both attainable docs retrieved
      {
        expected_ids: ['a', 'b', 'c'],
        missing_from_corpus: ['c'],
        attainable_retrieved: 2,
      },
      // 2 expected, all in corpus, 1 retrieved
      {
        expected_ids: ['d', 'e'],
        missing_from_corpus: [],
        attainable_retrieved: 1,
      },
    ]
    expect(docCoverage(cases)).toEqual({
      expected: 5,
      in_corpus: 4,
      retrieved: 3,
    })
  })

  test('a case with nothing attainable counts its expected docs but retrieves none', () => {
    const cases = [
      {
        expected_ids: ['a', 'b'],
        missing_from_corpus: ['a', 'b'],
        attainable_retrieved: null,
      },
    ]
    expect(docCoverage(cases)).toEqual({
      expected: 2,
      in_corpus: 0,
      retrieved: 0,
    })
  })

  test('no cases yields all zeros', () => {
    expect(docCoverage([])).toEqual({ expected: 0, in_corpus: 0, retrieved: 0 })
  })
})

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

// Latency is summarized over successful cases only (the caller filters): a
// timed-out case measures the timeout setting, not the system.

describe('latencySummary', () => {
  test('no values yields null — nothing was measurable', () => {
    expect(latencySummary([])).toBeNull()
  })

  test('a single value is its own mean, p50, and p95', () => {
    expect(latencySummary([1200])).toEqual({
      mean_ms: 1200,
      p50_ms: 1200,
      p95_ms: 1200,
    })
  })

  test('nearest-rank percentiles over an unsorted list', () => {
    // Sorted: 100..1000. Nearest rank: p50 → ceil(0.5*10)=5th → 500,
    // p95 → ceil(0.95*10)=10th → 1000.
    const values = [300, 100, 900, 500, 700, 200, 1000, 400, 800, 600]
    expect(latencySummary(values)).toEqual({
      mean_ms: 550,
      p50_ms: 500,
      p95_ms: 1000,
    })
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
