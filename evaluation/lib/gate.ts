/**
 * The no-facet gate: compare a run's set-level numbers to a committed baseline.
 *
 * It measures what a user gets with no facets — the control arm, not a facet
 * experiment. The baseline is the deterministic `EVAL_EXPANSION=off` arm, so a
 * drop is attributable. Update the baseline deliberately, in the PR whose
 * change is expected to move the scores.
 */
import * as fs from 'fs'

export interface GateSet {
  evalset_version: string
  map: number
  attainable_recall: number
  corpus_size?: number
}

export interface GateBaseline {
  tolerance_pp: number
  sets: Record<string, GateSet>
}

export interface GateReport {
  evalset: string
  evalset_version: string
  overall_map: number
  overall_attainable_recall: number
  corpus_size: number
}

export function loadGateBaseline(file: string): GateBaseline {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (e) {
    throw new Error(
      `--gate baseline ${file} is unreadable (${(e as Error).message})`,
    )
  }
  const baseline = parsed as GateBaseline
  if (
    typeof baseline?.tolerance_pp !== 'number' ||
    typeof baseline?.sets !== 'object' ||
    baseline.sets === null
  ) {
    throw new Error(
      `--gate baseline ${file} needs a numeric tolerance_pp and a sets object`,
    )
  }
  return baseline
}

export function checkGate(
  report: GateReport,
  baseline: GateBaseline,
): { ok: boolean; message: string } {
  const base = baseline.sets[report.evalset]
  if (!base) {
    return {
      ok: false,
      message: `GATE FAIL ${report.evalset}: no baseline entry — add one deliberately`,
    }
  }
  const map = report.overall_map * 100
  const ar = report.overall_attainable_recall * 100
  const tol = baseline.tolerance_pp
  const problems: string[] = []
  if (base.evalset_version !== report.evalset_version) {
    problems.push(
      `evalset version ${report.evalset_version} != baseline ${base.evalset_version}`,
    )
  }
  if (map < base.map - tol) {
    problems.push(`MAP ${map.toFixed(1)} < ${base.map.toFixed(1)} - ${tol}`)
  }
  if (ar < base.attainable_recall - tol) {
    problems.push(
      `aR ${ar.toFixed(1)} < ${base.attainable_recall.toFixed(1)} - ${tol}`,
    )
  }
  const corpus =
    base.corpus_size === undefined
      ? ''
      : ` (corpus ${report.corpus_size}, baseline ${base.corpus_size})`
  return {
    ok: problems.length === 0,
    message:
      `GATE ${problems.length ? 'FAIL' : 'PASS'} ${report.evalset}: ` +
      `MAP ${map.toFixed(1)} (baseline ${base.map.toFixed(1)} ±${tol}), ` +
      `aR ${ar.toFixed(1)} (baseline ${base.attainable_recall.toFixed(1)} ±${tol})` +
      `${corpus}${problems.length ? ` — ${problems.join('; ')}` : ''}`,
  }
}
