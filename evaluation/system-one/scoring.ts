/**
 * Pure scoring for the System One harness.
 *
 * Extracted from run.ts so the numbers can be tested. The harness's entire value
 * is the figures it prints and commits, and a wrong one is indistinguishable
 * from a right one in an artifact — which is how an 18-point accuracy error
 * survived into a committed result file before (see README, "A trap when adding
 * a facet").
 */
import type { Pick } from './systems'

export type ScoredRow = {
  document_id: string
  title: string
  gold: string
  goldInCandidates: boolean
  picks: Record<string, Pick & { ms: number }>
}

export type SystemRef = { id: string; note: string }

/** Reliability bin edges. The last edge is exclusive, hence 1.01. */
export const CONFIDENCE_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01]

/**
 * Per-system summary over scored rows.
 *
 * `results` is every row (documents × passes); `scored` is the subset whose gold
 * was inside the candidate set; `passes` is the per-pass split, kept separate
 * because that spread — not the pooled mean — is what says whether a gap between
 * systems is real.
 */
export function summariseSystems(args: {
  systems: SystemRef[]
  results: ScoredRow[]
  scored: ScoredRow[]
  passes: ScoredRow[][]
}) {
  const { systems, results, scored, passes } = args
  return systems.map((s) => {
    const picks = results.map((r) => r.picks[s.id])
    const correct = results.filter((r) => r.picks[s.id]?.label === r.gold)
    const correctInRecall = scored.filter((r) => r.picks[s.id]?.label === r.gold)
    const withConf = results.filter((r) => r.picks[s.id]?.confidence !== null)
    const brier = withConf.length
      ? withConf.reduce(
          (acc, r) =>
            acc + (r.picks[s.id].confidence! - (r.picks[s.id].label === r.gold ? 1 : 0)) ** 2,
          0,
        ) / withConf.length
      : null
    const goldMass = (() => {
      const probs = results.filter((r) => r.picks[s.id]?.probabilities)
      if (!probs.length) return null
      return (
        probs.reduce((acc, r) => acc + (r.picks[s.id].probabilities![r.gold] ?? 0), 0) /
        probs.length
      )
    })()
    const perPass = passes.map(
      (p) => p.filter((r) => r.picks[s.id]?.label === r.gold).length / p.length,
    )
    return {
      id: s.id,
      note: s.note,
      n: results.length,
      errors: picks.filter((p) => !p || p.label === null).length,
      top1: correct.length / results.length,
      top1InRecall: scored.length ? correctInRecall.length / scored.length : 0,
      accuracy: correct.length,
      meanConf: withConf.length
        ? withConf.reduce((a, r) => a + r.picks[s.id].confidence!, 0) / withConf.length
        : null,
      brier,
      goldMass,
      perPass,
      top1Min: perPass.length ? Math.min(...perPass) : 0,
      top1Max: perPass.length ? Math.max(...perPass) : 0,
      meanMs: picks.length ? picks.reduce((a, p) => a + (p?.ms ?? 0), 0) / picks.length : 0,
    }
  })
}

/** Reliability table: reported confidence against measured accuracy, per band. */
export function reliabilityBins(systems: SystemRef[], results: ScoredRow[]) {
  return systems
    .filter((s) => results.some((r) => r.picks[s.id]?.confidence !== null))
    .map((s) => {
      const table = CONFIDENCE_EDGES.slice(0, -1).map((lo, i) => {
        const hi = CONFIDENCE_EDGES[i + 1]
        const inBin = results.filter((r) => {
          const c = r.picks[s.id]?.confidence
          return c !== null && c !== undefined && c >= lo && c < hi
        })
        return {
          band: `${lo.toFixed(2)}–${hi === 1.01 ? '1.00' : hi.toFixed(2)}`,
          n: inBin.length,
          meanConf: inBin.length
            ? inBin.reduce((a, r) => a + r.picks[s.id].confidence!, 0) / inBin.length
            : null,
          accuracy: inBin.length
            ? inBin.filter((r) => r.picks[s.id].label === r.gold).length / inBin.length
            : null,
        }
      })
      return { id: s.id, table }
    })
}
