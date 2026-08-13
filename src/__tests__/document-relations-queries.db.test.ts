/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import {
  listRelations,
  reviewRelation,
  unlinkRelation,
  createManualRelation,
} from '@/db/queries/documentRelations'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('documentRelations queries', () => {
  const ext = `docrelq_test_${Date.now()}`
  let docA: string
  let docB: string
  let relId: string | null = null

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const rows = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status) VALUES
       ($1, $2, 'Rel Query A', 'searchable'),
       ($3, $4, 'Rel Query B', 'searchable') RETURNING id`,
      [`${ext}_a`, `documents/${ext}_a.pdf`, `${ext}_b`, `documents/${ext}_b.pdf`],
    )
    docA = rows[0].id
    docB = rows[1].id
  })

  afterAll(async () => {
    if (relId) {
      await AppDataSource.query(
        `DELETE FROM audit_log WHERE entity_type = 'document_relation' AND entity_id = $1`,
        [relId],
      )
    }
    await AppDataSource.query(
      `DELETE FROM document_relations WHERE document_id IN ($1, $2) OR related_document_id IN ($1, $2)`,
      [docA, docB],
    )
    await AppDataSource.query(`DELETE FROM documents WHERE id IN ($1, $2)`, [docA, docB])
    await AppDataSource.destroy()
  })

  it('createManualRelation inserts a confirmed human edge', async () => {
    const rel = await createManualRelation(docA, docB, 'tester')
    relId = rel.id
    expect(rel.status).toBe('confirmed')
    expect(rel.source).toBe('human')
    expect(rel.original.externalId).toContain('_b')
  })

  it('listRelations filters by status and joins both docs', async () => {
    const confirmed = await listRelations('confirmed')
    expect(confirmed.some((r) => r.documentId === docA)).toBe(true)
  })

  it('flip swaps direction and stamps reviewer', async () => {
    const [row] = await AppDataSource.query(
      `SELECT id FROM document_relations WHERE document_id = $1`, [docA])
    const flipped = await reviewRelation(row.id, 'flip', 'tester')
    expect(flipped!.documentId).toBe(docB)
    expect(flipped!.relatedDocumentId).toBe(docA)
    expect(flipped!.reviewedBy).toBe('tester')
  })

  it('unlink turns confirmed into rejected', async () => {
    const [row] = await AppDataSource.query(
      `SELECT id FROM document_relations WHERE related_document_id = $1`, [docA])
    const rel = await unlinkRelation(row.id, 'tester')
    expect(rel!.status).toBe('rejected')
  })

  it('review writes an audit row', async () => {
    const rows = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM audit_log
       WHERE entity_type = 'document_relation' AND action = 'relation_review'`)
    expect(rows[0].n).toBeGreaterThanOrEqual(2)
  })
})
