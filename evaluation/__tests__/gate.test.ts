import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { checkGate, GateBaseline, loadGateBaseline } from '../lib/gate'

const BASELINE: GateBaseline = {
  tolerance_pp: 1.0,
  sets: {
    'evalset_cite_01.json': {
      evalset_version: '3.2',
      map: 39.6,
      attainable_recall: 67.8,
      corpus_size: 219,
    },
  },
}

const report = (over: Record<string, unknown> = {}) => ({
  evalset: 'evalset_cite_01.json',
  evalset_version: '3.2',
  overall_map: 0.396,
  overall_attainable_recall: 0.678,
  corpus_size: 219,
  ...over,
})

it('passes at the baseline', () => {
  expect(checkGate(report(), BASELINE).ok).toBe(true)
})

it('passes within tolerance', () => {
  expect(checkGate(report({ overall_map: 0.387 }), BASELINE).ok).toBe(true)
})

it('fails when MAP falls below the tolerance', () => {
  const result = checkGate(report({ overall_map: 0.385 }), BASELINE)
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/MAP 38\.5 < 39\.6/)
})

it('fails when attainable recall falls below the tolerance', () => {
  const result = checkGate(
    report({ overall_attainable_recall: 0.667 }),
    BASELINE,
  )
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/aR 66\.7 < 67\.8/)
})

it('fails when the evalset version changes', () => {
  const result = checkGate(report({ evalset_version: '3.3' }), BASELINE)
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/evalset version 3\.3 != baseline 3\.2/)
})

it('fails for a set with no baseline entry', () => {
  const result = checkGate(report({ evalset: 'evalset_new.json' }), BASELINE)
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/no baseline entry/)
})

it('loads a baseline and rejects one without tolerance_pp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'))
  const good = path.join(dir, 'good.json')
  fs.writeFileSync(good, JSON.stringify(BASELINE))
  expect(loadGateBaseline(good).tolerance_pp).toBe(1.0)
  const bad = path.join(dir, 'bad.json')
  fs.writeFileSync(bad, JSON.stringify({ sets: {} }))
  expect(() => loadGateBaseline(bad)).toThrow(/tolerance_pp/)
})
