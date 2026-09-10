/** @jest-environment node */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateQueries } from '../experts/validate'

describe('evaluation/experts/queries.json', () => {
  it('parses and validates under the mode its own status declares', () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, '..', 'experts', 'queries.json'), 'utf8'),
    )
    // A file that claims status "labeled" must actually satisfy strict
    // validation (exactly 3 real author keys per query) — this is what
    // stops the set from being flipped to "labeled" without being filled in.
    const strict = raw.status === 'labeled'
    expect(validateQueries(raw, { strict })).toEqual([])
    expect(raw.queries.length).toBeGreaterThanOrEqual(10)
  })
  it('rejects a query without a key-shaped expectation', () => {
    expect(
      validateQueries({
        version: 1,
        status: 'labeled',
        queries: [
          { id: 'q1', query: 'x', expected_top3: ['Xue Lulu'], notes: '' },
        ],
      }),
    ).toEqual([
      'q1: expected_top3[0] "Xue Lulu" is not an author key (family, given)',
    ])
  })
  it('requires a declared status of "skeleton" or "labeled"', () => {
    expect(
      validateQueries({
        version: 1,
        queries: [{ id: 'q1', query: 'x', expected_top3: [], notes: '' }],
      }),
    ).toEqual(['status must be "skeleton" or "labeled"'])
  })
  it('allows empty expected_top3 in default (skeleton) mode', () => {
    expect(
      validateQueries({
        version: 1,
        status: 'skeleton',
        queries: [{ id: 'q1', query: 'x', expected_top3: [], notes: '' }],
      }),
    ).toEqual([])
  })
  it('rejects a set that declares itself labeled but still carries empty expected_top3 arrays under strict validation', () => {
    const errors = validateQueries(
      {
        version: 1,
        status: 'labeled',
        queries: [{ id: 'q1', query: 'x', expected_top3: [], notes: '' }],
      },
      { strict: true },
    )
    expect(errors).toEqual([
      'q1: expected_top3 must have exactly 3 entries in strict mode (has 0)',
    ])
  })
  it('the current skeleton set still passes in default (non-strict) mode', () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, '..', 'experts', 'queries.json'), 'utf8'),
    )
    expect(raw.status).toBe('skeleton')
    expect(validateQueries(raw)).toEqual([])
  })
})
