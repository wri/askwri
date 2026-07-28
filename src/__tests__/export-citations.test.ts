/**
 * @jest-environment node
 */
import { buildCitationsCsv } from '@/app/utils/exportCitationsCsv'
import { DocMeta } from '@/lib/llamacloud'
import { CatalogRow, buildCatalogIndex } from '@/app/utils/utils'

function makeDoc(overrides: Partial<DocMeta> = {}): DocMeta {
  return {
    doc_id: 'test-doc-1',
    ref: 'test-ref',
    title: 'Test Document',
    _url: 'test-doc-1.pdf',
    kps: [],
    ...overrides,
  }
}

function makeCatalogRow(overrides: Partial<CatalogRow> = {}): CatalogRow {
  return {
    allAuthors: 'Smith, John; Doe, Jane',
    articleType: 'Working Paper',
    office: 'WRI Global',
    summary:
      'This is the full long summary from the CSV catalog. It is complete and not truncated mid-sentence.',
    shortSummary: 'This is a long summary that has been trunca',
    raw: {
      'date published': '8/17/2021',
      languages: 'English',
      doi: 'https://doi.org/10.46830/test',
    },
    fileName: 'test-doc-1.pdf',
    baseName: 'test-doc-1.pdf',
    noExt: 'test-doc-1',
    ...overrides,
  }
}

describe('buildCitationsCsv', () => {
  it('uses the long summary, not the truncated short', () => {
    const doc = makeDoc()
    const row = makeCatalogRow()
    const index = buildCatalogIndex([row])
    const csv = buildCitationsCsv({
      docs: [doc],
      selectedIds: ['test-doc-1'],
      index,
      docSummary: {},
    })
    // The CSV should contain the full long summary, not the truncated short
    expect(csv).toContain('This is the full long summary from the CSV catalog.')
    expect(csv).not.toContain('has been trunca')
  })

  it('does not truncate the summary to 240 chars', () => {
    const longSummary = 'A'.repeat(500) + '. This is the end.'
    const doc = makeDoc()
    const row = makeCatalogRow({
      summary: longSummary,
      shortSummary: 'A'.repeat(240),
    })
    const index = buildCatalogIndex([row])
    const csv = buildCitationsCsv({
      docs: [doc],
      selectedIds: ['test-doc-1'],
      index,
      docSummary: {},
    })
    // The full 500+ char summary should be present, not sliced to 237
    expect(csv).toContain('This is the end.')
    expect(csv).not.toContain('...')
  })

  it('header does not claim "not part of the metadata"', () => {
    const doc = makeDoc()
    const index = buildCatalogIndex([makeCatalogRow()])
    const csv = buildCitationsCsv({
      docs: [doc],
      selectedIds: ['test-doc-1'],
      index,
      docSummary: {},
    })
    const headerLine = csv.split('\r\n')[0]
    expect(headerLine).not.toContain('not part of the metadata')
    expect(headerLine).toContain('Summary')
  })

  it('falls back to docSummary when row.summary is absent', () => {
    const doc = makeDoc()
    const row = makeCatalogRow({
      summary: undefined,
      shortSummary: 'Short text.',
    })
    const index = buildCatalogIndex([row])
    const csv = buildCitationsCsv({
      docs: [doc],
      selectedIds: ['test-doc-1'],
      index,
      docSummary: { 'test-doc-1': 'DocSummary fallback text.' },
    })
    expect(csv).toContain('DocSummary fallback text.')
  })
})
