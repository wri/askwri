/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { updateDocumentSummary } from '@/db/queries/documentsAdmin'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip
const identity = { kind: 'token', role: 'admin' } as const

d('updateDocumentSummary (DB integration)', () => {
  const externalId = `summaryedit_test_${Date.now()}`
  let docId: string

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const [row] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status, source_metadata)
       VALUES ($1, $2, 'Test Summary Edit', 'searchable', '{}'::jsonb) RETURNING id`,
      [externalId, `${externalId}.pdf`],
    )
    docId = row.id
    await AppDataSource.query(
      `INSERT INTO document_summaries (document_id, language, kind, text, source)
       VALUES ($1, 'en', 'long', 'Original long summary text.', 'external'),
              ($1, 'en', 'short', 'Original short.', 'external')`,
      [docId],
    )
  })

  afterAll(async () => {
    await AppDataSource.query('DELETE FROM document_summaries WHERE document_id = $1', [docId])
    await AppDataSource.query('DELETE FROM documents WHERE id = $1', [docId])
  })

  it('updates an external summary and writes an audit row', async () => {
    const result = await updateDocumentSummary(docId, 'en', 'long', 'Updated long summary text.', identity)
    expect(result).toEqual({ updated: true })
    const [row] = await AppDataSource.query(
      `SELECT text FROM document_summaries WHERE document_id = $1 AND language = 'en' AND kind = 'long'`,
      [docId],
    )
    expect(row.text).toBe('Updated long summary text.')
    const [audit] = await AppDataSource.query(
      `SELECT action, entity_type, before->>'text' AS before_text, after->>'text' AS after_text
       FROM audit_log WHERE entity_id = $1 AND entity_type = 'document_summary'
       ORDER BY at DESC LIMIT 1`,
      [docId],
    )
    expect(audit.action).toBe('update')
    expect(audit.before_text).toBe('Original long summary text.')
    expect(audit.after_text).toBe('Updated long summary text.')
  })

  it('returns { updated: false } when text is unchanged', async () => {
    const result = await updateDocumentSummary(docId, 'en', 'short', 'Original short.', identity)
    expect(result).toEqual({ updated: false })
  })

  it('returns null when the summary row does not exist', async () => {
    const result = await updateDocumentSummary(docId, 'zh', 'long', 'No such summary.', identity)
    expect(result).toBeNull()
  })

  it('rejects empty text', async () => {
    const result = await updateDocumentSummary(docId, 'en', 'long', '   ', identity)
    expect(result).toEqual({ error: 'summary text must not be empty' })
  })
})
