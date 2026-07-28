/**
 * @jest-environment node
 *
 * Integration test for getCatalogItems() against a real Postgres database.
 *
 * Skip guard: test is skipped (with a console.warn) unless process.env.DATABASE_URL
 * is set at runtime.  To run:
 *   npm run test:db
 *
 * TypeORM note: AppDataSource must be initialized before queries and destroyed
 * after to avoid open handle warnings in Jest.
 */

import { AppDataSource } from '@/db/data-source'
import { getCatalogItems } from '@/db/queries/getCatalogItems'

const DATABASE_URL = process.env.DATABASE_URL
// Corpus-precondition tests: require the migrated 169-doc corpus, absent in
// schema-only CI. Gated on RUN_CORPUS_TESTS (set by `npm run test:db`).
const corpusIt = process.env.RUN_CORPUS_TESTS === '1' ? it : it.skip

describe('getCatalogItems() DB integration', () => {
  if (!DATABASE_URL) {
    console.warn(
      '[catalog-items.db.test] Skipping: DATABASE_URL is not set. ' +
        'Run with `npm run test:db` to execute against a real database.',
    )
    it.skip('requires DATABASE_URL', () => {})
    return
  }

  // Ensure SSL is disabled for local docker DB
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

  corpusIt(
    'returns the migrated catalog items (≥169, tolerates worker uploads)',
    async () => {
      const items = await getCatalogItems()
      expect(items.length).toBeGreaterThanOrEqual(169)
    },
  )

  corpusIt('first item has the expected CatalogItem shape', async () => {
    const items = await getCatalogItems()
    expect(items.length).toBeGreaterThan(0)

    const first = items[0]

    // file_id is always '' (legacy CSV had no file_id column)
    expect(first.file_id).toBe('')

    // file_name must be a non-empty string (the s3_key / file_path)
    expect(typeof first.file_name).toBe('string')
    expect(first.file_name.length).toBeGreaterThan(0)

    // external_file_id is always ''
    expect(first.external_file_id).toBe('')

    // meta is an object with file_path, metadata (JSON string), summary
    expect(typeof first.meta).toBe('object')
    expect(first.meta).toHaveProperty('file_path')
    expect(first.meta).toHaveProperty('metadata')
    expect(first.meta).toHaveProperty('summary')

    // meta.metadata must be a JSON string that parses to an object
    expect(typeof first.meta.metadata).toBe('string')
    let parsedMeta: unknown
    expect(() => {
      parsedMeta = JSON.parse(first.meta.metadata as string)
    }).not.toThrow()
    expect(typeof parsedMeta).toBe('object')
    expect(parsedMeta).not.toBeNull()
  })

  it('meta.metadata parses to an object for all items', async () => {
    const items = await getCatalogItems()
    for (const item of items) {
      let parsed: unknown
      expect(() => {
        parsed = JSON.parse(item.meta.metadata as string)
      }).not.toThrow()
      expect(typeof parsed).toBe('object')
    }
  })
})
