/**
 * @jest-environment node
 */
import { mapDocumentToCatalogItem } from '@/db/queries/getCatalogItems'

const baseRow = {
  external_id: '2021_accelerating_1054',
  s3_key: '2021_accelerating_1054.pdf',
  source_metadata: {
    file_path: '2021_accelerating_1054.pdf',
    summary: 'A summary.',
    metadata: { 'Article Title': 'Accelerating Innovation' },
  },
  title: 'Accelerating Innovation',
  title_en: 'Accelerating Innovation',
  authors: 'Smith, John',
  url: 'https://wri.org/x',
  date_published: '2021-08-17',
  language: 'en',
  languages: ['en'],
  year_published: 2021,
  publication_title: 'Accelerating Innovation',
  article_type: 'Working Paper',
  wri_primary_office: 'WRI Global',
  doi: null,
  summary_en: null,
  short_summary_en: null,
}

describe('mapDocumentToCatalogItem', () => {
  it('preserves the legacy CSV catalog item shape', () => {
    const item = mapDocumentToCatalogItem(baseRow as any)
    expect(item.file_id).toBe('')
    expect(item.file_name).toBe('2021_accelerating_1054.pdf')
    expect(item.external_file_id).toBe('')
    expect(item.meta.file_path).toBe('2021_accelerating_1054.pdf')
    expect(item.meta.metadata).toBe(
      '{"Article Title":"Accelerating Innovation"}',
    )
    expect(item.meta.summary).toBe('A summary.')
  })

  it('carries the document-management fields in meta.dms', () => {
    const item = mapDocumentToCatalogItem({
      ...baseRow,
      language: 'zh',
      languages: ['zh'],
      title: '成都市小汽车拥有与使用政策战略研究',
      title_en: 'Smart Strategies for Private Vehicle Ownership in Chengdu',
      authors: 'Qiu, Shiyong; Liu, Daizong',
      wri_primary_office: 'WRI China',
      summary_en: 'The English long summary.',
      short_summary_en: 'The English short summary.',
    } as any)
    expect(item.meta.dms).toMatchObject({
      doc_id: '2021_accelerating_1054',
      title: '成都市小汽车拥有与使用政策战略研究',
      title_en: 'Smart Strategies for Private Vehicle Ownership in Chengdu',
      authors: 'Qiu, Shiyong; Liu, Daizong',
      year_published: 2021,
      wri_primary_office: 'WRI China',
      language: 'zh',
      languages: ['zh'],
      summary_en: 'The English long summary.',
      short_summary_en: 'The English short summary.',
    })
  })

  it('prefers document_summaries over the CSV summary fields', () => {
    const item = mapDocumentToCatalogItem({
      ...baseRow,
      source_metadata: {
        ...baseRow.source_metadata,
        summary: 'Stale CSV summary.',
        metadata: { short_summary: 'Stale CSV short summary.' },
      },
      summary_en: 'Current English long summary.',
      short_summary_en: 'Current English short summary.',
    } as any)
    expect(item.meta.summary).toBe('Current English long summary.')
    expect(item.meta.dms.short_summary_en).toBe(
      'Current English short summary.',
    )
  })

  it('falls back to the CSV summaries when document_summaries has no row', () => {
    const item = mapDocumentToCatalogItem({
      ...baseRow,
      source_metadata: {
        ...baseRow.source_metadata,
        metadata: { short_summary: 'CSV short summary.' },
      },
    } as any)
    expect(item.meta.summary).toBe('A summary.')
    expect(item.meta.dms.short_summary_en).toBe('CSV short summary.')
  })

  it('falls back to s3_key when source_metadata is missing', () => {
    const item = mapDocumentToCatalogItem({
      ...baseRow,
      s3_key: 'x.pdf',
      source_metadata: null,
    } as any)
    expect(item.file_name).toBe('x.pdf')
    expect(item.meta.file_path).toBe('x.pdf')
    expect(item.meta.metadata).toBe('{}')
    expect(item.meta.summary).toBe('')
  })
})
