/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { getReviewQueue } from '@/db/queries/reviewQueue'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('getReviewQueue (DB integration)', () => {
  const externalId = `review_test_${Date.now()}`
  let docId: string

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const [row] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status, extraction_confidence)
       VALUES ($1, $2, 'Review Test Doc', 'needs_review', 0.42) RETURNING id`,
      [externalId, `documents/${externalId}.pdf`],
    )
    docId = row.id
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, confidence, status)
       SELECT $1, id, 'llm', 0.55, 'suggested' FROM tags LIMIT 1`,
      [docId],
    )
  })

  afterAll(async () => {
    await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    await AppDataSource.destroy()
  })

  it('lists the needs_review doc with its suggested-tag count', async () => {
    const items = await getReviewQueue()
    const item = items.find((i) => i.externalId === externalId)
    expect(item).toBeTruthy()
    expect(item!.status).toBe('needs_review')
    expect(item!.extractionConfidence).toBeCloseTo(0.42)
    expect(item!.suggestedTagCount).toBe(1)
  })
})
