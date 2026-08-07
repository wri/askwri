/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { getDocumentHistory } from '@/db/queries/documentHistory'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('getDocumentHistory (DB integration)', () => {
  const externalId = `dochistory_test_${Date.now()}`
  const username = `history_test_user_${Date.now()}`
  let docId: string
  let userId: string
  let jobId: string
  let otherDocId: string

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()

    // Defensive: a crashed prior run can leave a test user behind; the UNIQUE
    // username constraint would then break every later run.
    await AppDataSource.query(
      `DELETE FROM users WHERE username LIKE 'history_test_user%'`,
    )

    const [doc] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Doc History Test', 'needs_review') RETURNING id`,
      [externalId, `documents/${externalId}.pdf`],
    )
    docId = doc.id

    // A second, unrelated document — its audit row must NOT appear.
    const otherExt = `dochistory_other_${Date.now()}`
    const [other] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Other Doc', 'needs_review') RETURNING id`,
      [otherExt, `documents/${otherExt}.pdf`],
    )
    otherDocId = other.id

    const [user] = await AppDataSource.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, 'x', 'editor') RETURNING id`,
      [username],
    )
    userId = user.id

    const [job] = await AppDataSource.query(
      `INSERT INTO ingestion_jobs (document_id, status) VALUES ($1, 'queued') RETURNING id`,
      [docId],
    )
    jobId = job.id

    // Five attributable audit rows, with distinct `at` timestamps (newest last
    // in insertion order) so DESC ordering is deterministic.
    // 1) field update — human, actor_user_id resolves to username via JOIN
    await AppDataSource.query(
      `INSERT INTO audit_log (actor_user_id, source, action, entity_type, entity_id, before, after, at)
       VALUES ($1, 'human', 'update', 'document', $2,
               '{"title":"Old"}'::jsonb, '{"title":"New"}'::jsonb, now() - interval '5 minutes')`,
      [userId, docId],
    )
    // 2) lifecycle change — human
    await AppDataSource.query(
      `INSERT INTO audit_log (actor_user_id, source, action, entity_type, entity_id, before, after, at)
       VALUES ($1, 'human', 'lifecycle', 'document', $2,
               '{"status":"needs_review"}'::jsonb, '{"status":"searchable"}'::jsonb, now() - interval '4 minutes')`,
      [userId, docId],
    )
    // 3) intake registration — system, NULL actor (Python writer, plural entity_type)
    await AppDataSource.query(
      `INSERT INTO audit_log (actor_user_id, source, action, entity_type, entity_id, before, after, at)
       VALUES (NULL, 'system', 'import', 'documents', $1,
               NULL, '{"externalId":"seed"}'::jsonb, now() - interval '3 minutes')`,
      [docId],
    )
    // 4) re-ingest request — keyed off the ingestion_job id
    await AppDataSource.query(
      `INSERT INTO audit_log (actor_user_id, source, action, entity_type, entity_id, before, after, at)
       VALUES ($1, 'human', 'create', 'ingestion_job', $2,
               NULL, '{"documentId":"seed","status":"queued"}'::jsonb, now() - interval '2 minutes')`,
      [userId, jobId],
    )
    // 5) collection membership change — matched via after->addedDocumentIds containment
    await AppDataSource.query(
      `INSERT INTO audit_log (actor_user_id, source, action, entity_type, entity_id, before, after, at)
       VALUES ($1, 'human', 'collection_change', 'collection', gen_random_uuid(),
               NULL, jsonb_build_object('addedDocumentIds', jsonb_build_array($2::text)), now() - interval '1 minute')`,
      [userId, docId],
    )
    // Unrelated row for a different document — must NOT appear.
    await AppDataSource.query(
      `INSERT INTO audit_log (actor_user_id, source, action, entity_type, entity_id, before, after)
       VALUES ($1, 'human', 'update', 'document', $2, '{"title":"X"}'::jsonb, '{"title":"Y"}'::jsonb)`,
      [userId, otherDocId],
    )
  })

  afterAll(async () => {
    // Audit rows first (the ingestion_job subquery needs the job to still exist),
    // then jobs (via document CASCADE), then documents and the user.
    await AppDataSource.query(
      `DELETE FROM audit_log
       WHERE entity_id = $1 OR entity_id = $2
       OR entity_id IN (SELECT id FROM ingestion_jobs WHERE document_id = $1)
       OR actor_user_id = $3`,
      [docId, otherDocId, userId],
    )
    await AppDataSource.query(`DELETE FROM documents WHERE id = ANY($1)`, [
      [docId, otherDocId],
    ])
    await AppDataSource.query(`DELETE FROM users WHERE id = $1`, [userId])
    await AppDataSource.destroy()
  })

  it('returns all attributable events for the doc, newest first, with actor resolution', async () => {
    const { total, entries } = await getDocumentHistory(docId, {
      limit: 50,
      offset: 0,
    })
    expect(total).toBe(5)
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'update',
        'lifecycle',
        'import',
        'create',
        'collection_change',
      ]),
    )
    const update = entries.find((e) => e.action === 'update')!
    expect(update.actor).toBe(username) // username via JOIN
    const intake = entries.find((e) => e.action === 'import')!
    expect(intake.actor).toBe('system') // NULL actor falls back to source
    const ats = entries.map((e) => +new Date(e.at))
    expect(ats).toEqual([...ats].sort((a, b) => b - a)) // at DESC
  })

  it('paginates with limit/offset and reports the true total', async () => {
    const page = await getDocumentHistory(docId, { limit: 2, offset: 0 })
    expect(page.entries).toHaveLength(2)
    expect(page.total).toBe(5)
  })
})
