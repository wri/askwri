/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import {
  getAdminDocumentDetail,
  updateDocumentFields,
  setDocumentStatus,
  reenqueueIngestion,
} from '@/db/queries/documentsAdmin'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip
const identity = { kind: 'token', role: 'admin' } as const

d('documentsAdmin (DB integration)', () => {
  const externalId = `docadmin_test_${Date.now()}`
  let docId: string

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const [row] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Doc Admin Test', 'needs_review') RETURNING id`,
      [externalId, `documents/${externalId}.pdf`],
    )
    docId = row.id
  })

  afterAll(async () => {
    // Job audit rows first (the subquery needs the jobs to still exist), then
    // the document — its FK is ON DELETE CASCADE, so deleting it removes jobs.
    await AppDataSource.query(
      `DELETE FROM audit_log WHERE entity_id = $1
       OR entity_id IN (SELECT id FROM ingestion_jobs WHERE document_id = $1)`,
      [docId],
    )
    await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    await AppDataSource.destroy()
  })

  it('returns detail for an existing document', async () => {
    const detail = await getAdminDocumentDetail(docId)
    expect(detail?.document.externalId).toBe(externalId)
    expect(Array.isArray(detail?.summaries)).toBe(true)
    expect(Array.isArray(detail?.tags)).toBe(true)
  })

  it('updates whitelisted fields and audits the diff', async () => {
    const result = await updateDocumentFields(
      docId,
      { title: 'Renamed', status: 'searchable' } as any, // status NOT whitelisted
      identity,
    )
    expect(result).toEqual({ updated: ['title'] })
    const [audit] = await AppDataSource.query(
      `SELECT action, before, after FROM audit_log
       WHERE entity_type='document' AND entity_id=$1 ORDER BY at DESC LIMIT 1`,
      [docId],
    )
    expect(audit.action).toBe('update')
    expect(audit.after).toEqual({ title: 'Renamed' })
  })

  it('rejects a non-numeric yearPublished', async () => {
    const result = await updateDocumentFields(docId, { yearPublished: 'abc' }, identity)
    expect(result).toEqual({ error: 'yearPublished must be an integer year' })
  })

  it('sets and clears yearPublished', async () => {
    const set = await updateDocumentFields(docId, { yearPublished: 2020 }, identity)
    expect(set).toEqual({ updated: ['yearPublished'] })
    const [row] = await AppDataSource.query(
      `SELECT year_published AS y FROM documents WHERE id = $1`,
      [docId],
    )
    expect(row.y).toBe(2020)

    const cleared = await updateDocumentFields(docId, { yearPublished: null }, identity)
    expect(cleared).toEqual({ updated: ['yearPublished'] })
    const [after] = await AppDataSource.query(
      `SELECT year_published AS y FROM documents WHERE id = $1`,
      [docId],
    )
    expect(after.y).toBeNull()
  })

  it('promotes needs_review -> searchable with a lifecycle audit row', async () => {
    const result = await setDocumentStatus(docId, 'searchable', identity)
    expect(result).toEqual({ fromStatus: 'needs_review' })
    const [row] = await AppDataSource.query(`SELECT status FROM documents WHERE id=$1`, [docId])
    expect(row.status).toBe('searchable')
  })

  it('rejects disallowed target statuses', async () => {
    const result = await setDocumentStatus(docId, 'draft', identity)
    expect(result).toHaveProperty('error')
  })

  it('refuses an editor restoring a withdrawn document, allows an admin', async () => {
    const editor = { kind: 'user', userId: 'x', username: 'e', role: 'editor' } as const
    // Withdraw (takedown) as admin first.
    const withdrawn = await setDocumentStatus(docId, 'withdrawn', identity)
    expect(withdrawn).toEqual({ fromStatus: 'searchable' })

    // Editor cannot reverse the takedown.
    const refused = await setDocumentStatus(docId, 'searchable', editor)
    expect(refused).toEqual({ forbidden: true })
    const [still] = await AppDataSource.query(`SELECT status FROM documents WHERE id=$1`, [docId])
    expect(still.status).toBe('withdrawn')

    // Admin can.
    const restored = await setDocumentStatus(docId, 'searchable', identity)
    expect(restored).toEqual({ fromStatus: 'withdrawn' })
    const [row] = await AppDataSource.query(`SELECT status FROM documents WHERE id=$1`, [docId])
    expect(row.status).toBe('searchable')
  })

  it('re-enqueues ingestion once, then refuses while the job is open', async () => {
    // Cleanup happens in afterAll (job audit rows via the ingestion_jobs
    // subquery, the jobs themselves via the document's ON DELETE CASCADE),
    // so a failed assertion here cannot leak rows.
    const first = await reenqueueIngestion(docId, identity)
    expect(first).toHaveProperty('jobId')
    const second = await reenqueueIngestion(docId, identity)
    expect(second).toEqual({ error: 'an open ingestion job already exists' })
    const third = await reenqueueIngestion(docId, identity)
    expect(third).toEqual({ error: 'an open ingestion job already exists' })
  })
})
