/** @jest-environment node */
// Pure unit tests for the WRI-keywords → managed-topic-CSV converter (spec
// §10.2 "seed step": raw WRI CSV loads once into the managed format). No DB,
// no filesystem — only the pure convertWriKeywordsCsv function.
import { convertWriKeywordsCsv } from '../../scripts/convert-wri-keywords-csv'
import { parseTopicsCsv } from '@/db/queries/topicsAdmin'

describe('convertWriKeywordsCsv (no DB)', () => {
  it('prepends the managed header and emits one managed row per keyword', () => {
    const wri = ['Access Rights,,,', 'Accessibility,,,', 'Coal,,,'].join('\n')
    const managed = convertWriKeywordsCsv(wri)

    const lines = managed.split('\n')
    expect(lines[0]).toBe('label,description,aliases,parent,facet,id')
    // Trailing newline is fine (matches exportTopicsCsv); the contract is the
    // row count the importer sees, asserted below via parseTopicsCsv.
    expect(managed.endsWith('\n')).toBe(true)

    const rows = parseTopicsCsv(managed)
    expect(rows.length).toBe(3)
    expect(rows.map((r) => r.label)).toEqual([
      'Access Rights',
      'Accessibility',
      'Coal',
    ])
    for (const r of rows) {
      expect(r.facet).toBe('topic')
      expect(r.description).toBe('')
      expect(r.aliases).toEqual([])
      expect(r.parent).toBe('')
      expect(r.id).toBe('')
    }
  })

  it('preserves a quoted keyword that contains commas (round-trips through parseTopicsCsv)', () => {
    // The WRI file quotes multi-word keywords with embedded commas. The
    // converter must not split on those inner commas, and the managed output
    // must round-trip through the importer's own quote-aware parser.
    const wri = [
      '"Water, Sanitation, and Hygiene",,,',
      'Coal,,,',
      '"Zero-Emission Trucks",,,',
    ].join('\n')
    const managed = convertWriKeywordsCsv(wri)
    const rows = parseTopicsCsv(managed)
    expect(rows.map((r) => r.label)).toEqual([
      'Water, Sanitation, and Hygiene',
      'Coal',
      'Zero-Emission Trucks',
    ])
  })

  it('skips blank lines and lines whose only field is empty', () => {
    const wri = ['Coal,,,', '', '   ,,,', 'Solar,,,'].join('\n')
    const managed = convertWriKeywordsCsv(wri)
    const rows = parseTopicsCsv(managed)
    expect(rows.map((r) => r.label)).toEqual(['Coal', 'Solar'])
  })

  it('handles CRLF line endings without leaking \\r into labels', () => {
    const wri = ['Coal,,,\r\nSolar,,,\r\n'].join('')
    const managed = convertWriKeywordsCsv(wri)
    const rows = parseTopicsCsv(managed)
    expect(rows.map((r) => r.label)).toEqual(['Coal', 'Solar'])
  })

  it('throws on an empty input (nothing to seed)', () => {
    expect(() => convertWriKeywordsCsv('')).toThrow(/empty/i)
    expect(() => convertWriKeywordsCsv('\n\n')).toThrow(/empty/i)
  })

  it('produces output that diff-imports with zero conflicts against a known-good parse (structural)', () => {
    // Structural guarantee: the converted output must itself be valid managed
    // CSV — i.e. parseTopicsCsv must not throw the missing-header error on it.
    const wri = ['Access Rights,,,', 'Coal,,,'].join('\n')
    const managed = convertWriKeywordsCsv(wri)
    expect(() => parseTopicsCsv(managed)).not.toThrow()
  })
})
