/** @jest-environment node */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateQueries } from '../experts/validate'

describe('evaluation/experts/queries.json', () => {
  it('parses and validates', () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, '..', 'experts', 'queries.json'), 'utf8'),
    )
    expect(validateQueries(raw)).toEqual([])
    expect(raw.queries.length).toBeGreaterThanOrEqual(10)
  })
  it('rejects a query without a key-shaped expectation', () => {
    expect(
      validateQueries({
        version: 1,
        queries: [
          { id: 'q1', query: 'x', expected_top3: ['Xue Lulu'], notes: '' },
        ],
      }),
    ).toEqual([
      'q1: expected_top3[0] "Xue Lulu" is not an author key (family, given)',
    ])
  })
})
