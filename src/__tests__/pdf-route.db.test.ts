/**
 * @jest-environment node
 *
 * Integration test for getDocumentForPdf() — the lookup the public PDF route
 * uses to find a document's s3_key by external_id and gate on status.
 */

import { AppDataSource } from '@/db/data-source'
import { getDocumentForPdf } from '@/db/queries/getDocumentForPdf'

const DATABASE_URL = process.env.DATABASE_URL
// Corpus-precondition tests: require the migrated 169-doc corpus, absent in
// schema-only CI. Gated on RUN_CORPUS_TESTS (set by `npm run test:db`).
const corpusIt = process.env.RUN_CORPUS_TESTS === '1' ? it : it.skip

describe('getDocumentForPdf (DB integration)', () => {
  if (!DATABASE_URL) {
    console.warn(
      '[pdf-route.db.test] Skipping: DATABASE_URL is not set. ' +
        'Run with `npm run test:db` to execute against a real database.',
    )
    it.skip('requires DATABASE_URL', () => {})
    return
  }

  beforeAll(async () => {
    process.env.DATABASE_SSL = process.env.DATABASE_SSL ?? 'false'
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize()
    }
  })

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
  })

  corpusIt('returns s3Key + status for a searchable migrated doc', async () => {
    const doc = await getDocumentForPdf(
      '2021_accelerating-innovation-in-urban-service-delivery_1054',
    )
    expect(doc).not.toBeNull()
    expect(doc!.s3Key).toBe(
      '2021_accelerating-innovation-in-urban-service-delivery_1054.pdf',
    )
    expect(doc!.status).toBe('searchable')
  })

  it('returns null for a nonexistent external_id', async () => {
    const doc = await getDocumentForPdf('does-not-exist-12345')
    expect(doc).toBeNull()
  })

  corpusIt('returns status=withdrawn for the withdrawn canary', async () => {
    const doc = await getDocumentForPdf('askwri-canary-1783377155')
    expect(doc).not.toBeNull()
    expect(doc!.status).toBe('withdrawn')
  })
})
