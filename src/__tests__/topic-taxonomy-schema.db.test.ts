/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('topic taxonomy schema (DB integration)', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })
  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it('tags has parent_tag_id, description, needs_reembed', async () => {
    const rows: any[] = await AppDataSource.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='tags' AND column_name IN ('parent_tag_id','description','needs_reembed')`,
    )
    const names = rows.map((r) => r.column_name).sort()
    expect(names).toEqual(['description', 'needs_reembed', 'parent_tag_id'])
  })

  it('tag_aliases composite PK exists', async () => {
    const [row]: any[] = await AppDataSource.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid='tag_aliases'::regclass AND contype='p'`,
    )
    expect(row?.conname).toBe('PK_tag_aliases')
  })

  it('tag_embeddings HNSW index exists', async () => {
    const rows: any[] = await AppDataSource.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='tag_embeddings'`,
    )
    expect(rows.map((r) => r.indexname)).toContain('idx_tag_embeddings_hnsw')
  })

  it('reclassify_jobs idempotent partial unique index', async () => {
    const rows: any[] = await AppDataSource.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname='reclassify_jobs_one_open_per_doc'`,
    )
    expect(rows.length).toBe(1)
    expect(rows[0].indexdef).toMatch(/status.*queued.*running/i)
  })
})
