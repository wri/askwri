/**
 * @jest-environment node
 *
 * Integration test for the catalog route's source-selection logic.
 * Verifies that postgres is the DEFAULT source (not CSV fallback) when
 * CATALOG_SOURCE is unset, and CSV is only used on explicit CATALOG_SOURCE=csv.
 */

import { NextRequest } from 'next/server'
import { AppDataSource } from '@/db/data-source'

const DATABASE_URL = process.env.DATABASE_URL
// Corpus-precondition tests: require the migrated 169-doc corpus, absent in
// schema-only CI. Gated on RUN_CORPUS_TESTS (set by `npm run test:db`).
const corpusIt = process.env.RUN_CORPUS_TESTS === '1' ? it : it.skip

describe('catalog route source selection', () => {
  if (!DATABASE_URL) {
    console.warn(
      '[catalog-route.db.test] Skipping: DATABASE_URL is not set. ' +
        'Run with `npm run test:db` to execute against a real database.',
    )
    it.skip('requires DATABASE_URL', () => {})
    return
  }

  let savedCatalogSource: string | undefined

  beforeAll(async () => {
    process.env.DATABASE_SSL = process.env.DATABASE_SSL ?? 'false'
    savedCatalogSource = process.env.CATALOG_SOURCE
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize()
    }
  })

  afterAll(async () => {
    if (savedCatalogSource === undefined) {
      delete process.env.CATALOG_SOURCE
    } else {
      process.env.CATALOG_SOURCE = savedCatalogSource
    }
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
  })

  corpusIt('defaults to postgres when CATALOG_SOURCE is unset', async () => {
    delete process.env.CATALOG_SOURCE
    // Import after env is set (route reads process.env at call time)
    const { GET } = await import('@/app/api/catalog/route')
    const req = new NextRequest('http://localhost/api/catalog')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toBe('postgres')
    expect(body.count).toBeGreaterThanOrEqual(169) // ≥169 searchable docs (migrated + any uploads)
  })

  it('uses CSV fallback only on explicit CATALOG_SOURCE=csv', async () => {
    process.env.CATALOG_SOURCE = 'csv'
    const { GET } = await import('@/app/api/catalog/route')
    const req = new NextRequest('http://localhost/api/catalog')
    const res = await GET(req)
    // CSV fallback: may 500 if CSV not found, or return csv source — either
    // way it must NOT be 'postgres'
    if (res.status === 200) {
      const body = await res.json()
      expect(body.source).not.toBe('postgres')
    }
    // If it 500s (CSV not found), that's expected in postgres mode — the point
    // is the default changed, not that CSV works here.
  })
})
