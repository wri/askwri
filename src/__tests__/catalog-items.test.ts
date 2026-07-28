/**
 * @jest-environment node
 */
import { mapDocumentToCatalogItem } from '@/db/queries/getCatalogItems'

describe('mapDocumentToCatalogItem', () => {
  it('reproduces the legacy CSV catalog item shape', () => {
    const doc = {
      s3Key: '2021_accelerating_1054.pdf',
      sourceMetadata: {
        file_path: '2021_accelerating_1054.pdf',
        summary: 'A summary.',
        metadata: { 'Article Title': 'Accelerating Innovation' },
      },
    }
    expect(mapDocumentToCatalogItem(doc as any)).toEqual({
      file_id: '',
      file_name: '2021_accelerating_1054.pdf',
      external_file_id: '',
      meta: {
        file_path: '2021_accelerating_1054.pdf',
        metadata: '{"Article Title":"Accelerating Innovation"}',
        summary: 'A summary.',
      },
    })
  })

  it('falls back to s3Key when source_metadata is missing', () => {
    const doc = { s3Key: 'x.pdf', sourceMetadata: null }
    const item = mapDocumentToCatalogItem(doc as any)
    expect(item.file_name).toBe('x.pdf')
    expect(item.meta).toEqual({
      file_path: 'x.pdf',
      metadata: '{}',
      summary: '',
    })
  })
})
