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
    expect(result?.updated).toEqual(['title'])
    const [audit] = await AppDataSource.query(
      `SELECT action, before, after FROM audit_log
       WHERE entity_type='document' AND entity_id=$1 ORDER BY at DESC LIMIT 1`,
      [docId],
    )
    expect(audit.action).toBe('update')
    expect(audit.after).toEqual({ title: 'Renamed' })
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

  it('re-enqueues ingestion once, then refuses while the job is open', async () => {
    const first = await reenqueueIngestion(docId, identity)
    expect(first).toHaveProperty('jobId')
    const second = await reenqueueIngestion(docId, identity)
    expect(second).toHaveProperty('error')
    // Clean up the job AND its audit row here — afterAll's audit cleanup
    // joins on ingestion_jobs, which would already be empty by then.
    await AppDataSource.query(`DELETE FROM audit_log WHERE entity_id = $1`, [
      (first as { jobId: string }).jobId,
    ])
    await AppDataSource.query(`DELETE FROM ingestion_jobs WHERE document_id = $1`, [docId])
  })
})
