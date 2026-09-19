/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('document_relations schema', () => {
  const ext = `docrel_test_${Date.now()}`
  let docA: string
  let docB: string

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const rows = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status) VALUES
       ($1, $2, 'Rel Test A', 'searchable'),
       ($3, $4, 'Rel Test B', 'searchable') RETURNING id`,
      [
        `${ext}_a`,
        `documents/${ext}_a.pdf`,
        `${ext}_b`,
        `documents/${ext}_b.pdf`,
      ],
    )
    docA = rows[0].id
    docB = rows[1].id
  })

  afterAll(async () => {
    await AppDataSource.query(
      `DELETE FROM document_relations WHERE document_id IN ($1, $2) OR related_document_id IN ($1, $2)`,
      [docA, docB],
    )
    await AppDataSource.query(`DELETE FROM documents WHERE id IN ($1, $2)`, [
      docA,
      docB,
    ])
    await AppDataSource.destroy()
  })

  it('inserts a suggested edge with defaults', async () => {
    const [row] = await AppDataSource.query(
      `INSERT INTO document_relations (document_id, related_document_id, source, confidence, signals)
       VALUES ($1, $2, 'system', 0.9, '{"trigger":"title"}') RETURNING *`,
      [docA, docB],
    )
    expect(row.relation_type).toBe('translation_of')
    expect(row.status).toBe('suggested')
  })

  it('rejects the same pair in either direction', async () => {
    await expect(
      AppDataSource.query(
        `INSERT INTO document_relations (document_id, related_document_id, source)
         VALUES ($1, $2, 'system')`,
        [docB, docA],
      ),
    ).rejects.toThrow(/duplicate key|UQ_document_relations_pair/)
  })

  it('rejects a self-edge', async () => {
    await expect(
      AppDataSource.query(
        `INSERT INTO document_relations (document_id, related_document_id, source)
         VALUES ($1, $1, 'human')`,
        [docA],
      ),
    ).rejects.toThrow(/CHK_document_relations_not_self|check constraint/)
  })

  it('allows only one confirmed translation_of per translation doc', async () => {
    await AppDataSource.query(
      `UPDATE document_relations SET status = 'confirmed' WHERE document_id = $1`,
      [docA],
    )
    const [row] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Rel Test C', 'searchable') RETURNING id`,
      [`${ext}_c`, `documents/${ext}_c.pdf`],
    )
    try {
      await expect(
        AppDataSource.query(
          `INSERT INTO document_relations (document_id, related_document_id, source, status)
           VALUES ($1, $2, 'human', 'confirmed')`,
          [docA, row.id],
        ),
      ).rejects.toThrow(/duplicate key|UQ_document_relations_confirmed/)
    } finally {
      await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [row.id])
    }
  })
})
