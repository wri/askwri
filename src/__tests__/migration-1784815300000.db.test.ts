/** @jest-environment node */
/**
 * Migration 1784815300000 — retire the text-embedding-3-small partial HNSW
 * index once (and only once) the corpus no longer contains 3-small rows.
 *
 * The drop is deliberately CONDITIONAL. qa completed the cohere-embed-v4
 * cutover on 2026-07-23, but production has NOT — and migrations run on both.
 * Dropping the index unconditionally would strip the index backing
 * production's live dense lane, turning every dense query into a sequential
 * scan over the whole chunk table. So the invariant under test is a biconditional,
 * not "the index is gone": the index exists if and only if 3-small rows do.
 *
 * Pattern follows the established repo convention (migration-178132.db.test.ts):
 * inline hasDb/d + AppDataSource.query — no runSql helper exists.
 */
import { AppDataSource } from '@/db/data-source'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

const indexExists = async (name: string): Promise<boolean> => {
  const rows = await AppDataSource.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [name],
  )
  return rows.length > 0
}

d('migration 1784815300000 — conditional 3-small index retirement', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })

  afterAll(async () => {
    await AppDataSource.destroy()
  })

  it('drops the 3-small index only when no 3-small chunks remain', async () => {
    const [{ count }] = await AppDataSource.query(
      `SELECT count(*)::int AS count FROM document_chunks
       WHERE embedding_model = 'text-embedding-3-small'`,
    )
    const present = await indexExists('idx_chunks_embedding_hnsw')

    if (count === 0) {
      expect(present).toBe(false)
    } else {
      // Pre-cutover environment (production): the index is still load-bearing.
      expect(present).toBe(true)
    }
  })

  it('leaves the cohere-embed-v4 index in place', async () => {
    expect(await indexExists('idx_chunks_embedding_hnsw_cohere_v4')).toBe(true)
  })

  it('keeps every chunk reachable by exactly one embedding model', async () => {
    const rows = await AppDataSource.query(
      `SELECT embedding_model, count(*)::int AS count FROM document_chunks
       GROUP BY embedding_model ORDER BY count DESC`,
    )
    // No chunk should be left without a model label — that row would be
    // covered by neither partial index and would silently vanish from dense.
    const unlabelled = rows.filter((r: any) => r.embedding_model === null)
    expect(unlabelled).toHaveLength(0)
  })
})
