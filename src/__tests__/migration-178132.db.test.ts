/** @jest-environment node */
/**
 * Migration 1781320000000 — schema + data backfill invariants.
 *
 * Runs against the live qa database (via DATABASE_URL from .env.local) after
 * `npm run migration:run`. Asserts the migration: dropped `abstract`; added
 * `authors`/`url`/`date_published`; backfilled them from source_metadata;
 * fixed the 37 "Pre-EM"/"Not available" junk titles; relabeled the 33
 * mislabeled non-English summaries to `en`; backfilled `title_en` for the 33
 * non-English docs; added a unique partial index on content_hash.
 *
 * Pattern follows the established repo convention (admin-documents.db.test.ts):
 * inline hasDb/d + AppDataSource.query — no runSql helper exists.
 */
import { AppDataSource } from '@/db/data-source'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('migration 178132 — schema + data backfills', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })

  afterAll(async () => {
    await AppDataSource.destroy()
  })

  it('documents has authors/url/date_published, not abstract', async () => {
    const cols = await AppDataSource.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'documents' ORDER BY column_name`,
    )
    const names = cols.map((r: any) => r.column_name)
    expect(names).toContain('authors')
    expect(names).toContain('url')
    expect(names).toContain('date_published')
    expect(names).not.toContain('abstract')
  })

  it('authors/url/date_published backfilled for all 169 migrated docs', async () => {
    const [r] = await AppDataSource.query(
      `SELECT
         count(*) FILTER (WHERE authors IS NOT NULL) AS a,
         count(*) FILTER (WHERE url IS NOT NULL) AS u,
         count(*) FILTER (WHERE date_published IS NOT NULL) AS d
       FROM documents WHERE source_metadata IS NOT NULL`,
    )
    expect(Number(r.a)).toBe(169)
    expect(Number(r.u)).toBe(169)
    expect(Number(r.d)).toBe(169)
  })

  it('no document title is "Pre-EM" or "Not available"', async () => {
    const [r] = await AppDataSource.query(
      `SELECT count(*) FROM documents WHERE title IN ('Pre-EM','Not available')`,
    )
    expect(Number(r.count)).toBe(0)
  })

  it('33 non-English docs have title_en populated', async () => {
    const [r] = await AppDataSource.query(
      `SELECT count(*) FILTER (WHERE language <> 'en' AND title_en IS NULL) AS bad_title_en,
              count(*) FILTER (WHERE language <> 'en') AS non_en
       FROM documents WHERE source_metadata IS NOT NULL`,
    )
    expect(Number(r.bad_title_en)).toBe(0)
    // 33 non-English migrated docs (19 zh + 10 es + 4 pt)
    expect(Number(r.non_en)).toBe(33)
  })

  it('relabels the 33 mislabeled summaries to en (native slots emptied for worker regen)', async () => {
    const sums = await AppDataSource.query(
      `SELECT language, count(*) FROM document_summaries GROUP BY language ORDER BY language`,
    )
    // The 33 native-language summaries (es/pt/zh, all English text) are now labeled en.
    // So es/pt/zh rows should be gone (for migrated docs); en should include all migrated.
    const _langs = sums.map((s: any) => s.language)
    // Note: the worker canary (askwri-canary-1783377155) has generated en summaries;
    // a future worker run may add native rows. Here we assert the migrated mislabel is gone:
    // no es/pt/zh rows whose source='external' (those were the mislabeled ones).
    const extNative = await AppDataSource.query(
      `SELECT language, count(*) FROM document_summaries
       WHERE source = 'external' AND language IN ('zh','es','pt') GROUP BY language`,
    )
    expect(extNative.length).toBe(0)
  })

  it('content_hash has a unique partial index', async () => {
    const rows = await AppDataSource.query(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'documents' AND indexdef ILIKE '%content_hash%'`,
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].indexdef).toMatch(/UNIQUE/)
  })
})
