/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { getReviewQueue } from '@/db/queries/reviewQueue'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('getReviewQueue (DB integration)', () => {
  const externalId = `review_test_${Date.now()}`
  let docId: string
  let tagId: string

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const [row] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status, extraction_confidence)
       VALUES ($1, $2, 'Review Test Doc', 'needs_review', 0.42) RETURNING id`,
      [externalId, `documents/${externalId}.pdf`],
    )
    docId = row.id
    // Throwaway tag: don't depend on the tags table being populated.
    const [tagRow] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('topic', $1, 'v1') RETURNING id`,
      [`__review_queue_test_${Date.now()}__`],
    )
    tagId = tagRow.id
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, confidence, status)
       VALUES ($1, $2, 'llm', 0.55, 'suggested')`,
      [docId, tagId],
    )
  })

  afterAll(async () => {
    // Deleting the document cascades document_tags rows.
    await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    await AppDataSource.query(`DELETE FROM tags WHERE id = $1`, [tagId])
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
