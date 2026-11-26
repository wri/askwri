/**
 * Pins the scoring math. The harness's only failure mode is a wrong number in a
 * committed artifact, and a wrong number looks exactly like a right one — which
 * is how an 18-point error reached a result file before.
 */
import { summariseSystems, reliabilityBins, type ScoredRow } from '../scoring'
import type { Pick } from '../systems'

const pick = (label: string | null, confidence: number | null, probabilities?: Record<string, number>): Pick & { ms: number } => ({
  label,
  confidence,
  probabilities,
  ms: 10,
})

const row = (
  gold: string,
  picks: Record<string, Pick & { ms: number }>,
  goldInCandidates = true,
): ScoredRow => ({
  document_id: `doc-${gold}-${Math.random()}`,
  title: 't',
  gold,
  goldInCandidates,
  picks,
})

describe('summariseSystems', () => {
  const systems = [{ id: 'a', note: 'n' }]

  it('counts top1 over all rows and flags unusable picks as errors', () => {
    const results = [
      row('x', { a: pick('x', 0.9) }),
      row('x', { a: pick('y', 0.8) }),
      row('x', { a: pick(null, null, undefined) }),
    ]
    const [s] = summariseSystems({ systems, results, scored: results, passes: [results] })
    expect(s.n).toBe(3)
    expect(s.accuracy).toBe(1)
    expect(s.top1).toBeCloseTo(1 / 3)
    expect(s.errors).toBe(1)
  })

  it('computes Brier over answered rows only, against the binary outcome', () => {
    const results = [
      row('x', { a: pick('x', 1.0) }), // correct, conf 1.0 -> 0
      row('x', { a: pick('y', 0.0) }), // wrong,   conf 0.0 -> 0
      row('x', { a: pick(null, null) }), // excluded
    ]
    const [s] = summariseSystems({ systems, results, scored: results, passes: [results] })
    expect(s.brier).toBe(0)
    expect(s.meanConf).toBeCloseTo(0.5)
  })

  it('restricts top1InRecall to rows whose gold was inside the candidate set', () => {
    const inRecall = row('x', { a: pick('x', 0.9) }, true)
    const outOfRecall = row('x', { a: pick('y', 0.9) }, false)
    const results = [inRecall, outOfRecall]
    const [s] = summariseSystems({
      systems,
      results,
      scored: results.filter((r) => r.goldInCandidates),
      passes: [results],
    })
    expect(s.top1).toBeCloseTo(0.5)
    expect(s.top1InRecall).toBe(1)
  })

  it('keeps per-pass accuracy separate from the pooled mean', () => {
    const passOne = [row('x', { a: pick('x', 0.9) }), row('x', { a: pick('y', 0.9) })]
    const passTwo = [row('x', { a: pick('x', 0.9) }), row('x', { a: pick('x', 0.9) })]
    const results = [...passOne, ...passTwo]
    const [s] = summariseSystems({ systems, results, scored: results, passes: [passOne, passTwo] })
    expect(s.perPass).toEqual([0.5, 1])
    expect(s.top1Min).toBe(0.5)
    expect(s.top1Max).toBe(1)
    // pooled is the mean of the two passes here, but is asserted independently
    expect(s.top1).toBeCloseTo(0.75)
  })

  it('reports no Infinity for min/max when there are no passes', () => {
    // Math.min(...[]) === Infinity, which is how REPS=0 produced a garbage artifact.
    const results = [row('x', { a: pick('x', 0.9) })]
    const [s] = summariseSystems({ systems, results, scored: results, passes: [] })
    expect(s.top1Min).toBe(0)
    expect(s.top1Max).toBe(0)
    expect(Number.isFinite(s.top1)).toBe(true)
  })

  it('averages probability mass on the gold label, and reports null when absent', () => {
    const withProbs = [
      row('x', { a: pick('x', 0.9, { x: 0.8, y: 0.2 }) }),
      row('x', { a: pick('y', 0.9, { x: 0.4, y: 0.6 }) }),
    ]
    expect(
      summariseSystems({ systems, results: withProbs, scored: withProbs, passes: [withProbs] })[0]
        .goldMass,
    ).toBeCloseTo(0.6)

    const without = [row('x', { a: pick('x', 0.9) })]
    expect(
      summariseSystems({ systems, results: without, scored: without, passes: [without] })[0].goldMass,
    ).toBeNull()
  })
})

describe('reliabilityBins', () => {
  const systems = [{ id: 'a', note: 'n' }]

  it('buckets by band and puts a confidence of exactly 1.0 in the top band', () => {
    const results = [
      row('x', { a: pick('x', 1.0) }),
      row('x', { a: pick('x', 0.95) }),
      row('x', { a: pick('y', 0.65) }),
    ]
    const [b] = reliabilityBins(systems, results)
    const top = b.table.find((r) => r.band === '0.90–1.00')!
    const mid = b.table.find((r) => r.band === '0.60–0.70')!
    expect(top.n).toBe(2) // 1.0 is inclusive via the 1.01 edge
    expect(top.accuracy).toBe(1)
    expect(mid.n).toBe(1)
    expect(mid.accuracy).toBe(0)
  })

  it('skips systems that never report confidence', () => {
    const results = [row('x', { a: pick('x', null) })]
    expect(reliabilityBins(systems, results)).toEqual([])
  })
})
