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
    await AppDataSource.query(`DELETE FROM documents WHERE id IN ($1, $2)`, [
      docA,
      docB,
    ])
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
      `SELECT id FROM document_relations WHERE document_id = $1`,
      [docA],
    )
    const flipped = await reviewRelation(row.id, 'flip', 'tester')
    expect(flipped!.documentId).toBe(docB)
    expect(flipped!.relatedDocumentId).toBe(docA)
    expect(flipped!.reviewedBy).toBe('tester')
  })

  it('unlink turns confirmed into rejected', async () => {
    const [row] = await AppDataSource.query(
      `SELECT id FROM document_relations WHERE related_document_id = $1`,
      [docA],
    )
    const rel = await unlinkRelation(row.id, 'tester')
    expect(rel!.status).toBe('rejected')
  })

  it('review writes an audit row', async () => {
    const rows = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM audit_log
       WHERE entity_type = 'document_relation' AND action = 'relation_review'`,
    )
    expect(rows[0].n).toBeGreaterThanOrEqual(2)
  })
})

d('documentRelations conflict cases (issue #325 review fix)', () => {
  // The partial unique index UQ_document_relations_confirmed (one confirmed
  // translation_of per document_id) and the undirected UQ_document_relations_pair
  // can reject a confirm/flip/manual-create. Those DB errors must surface as a
  // typed {conflict: true, reason} — not an unhandled 500.
  const ext = `docrelconf_test_${Date.now()}`
  let docA: string
  let docB: string
  let docC: string
  const createdRelIds: string[] = []

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const rows = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status) VALUES
         ($1, $2, 'Conf A', 'searchable'),
         ($3, $4, 'Conf B', 'searchable'),
         ($5, $6, 'Conf C', 'searchable') RETURNING id`,
      [
        `${ext}_a`,
        `documents/${ext}_a.pdf`,
        `${ext}_b`,
        `documents/${ext}_b.pdf`,
        `${ext}_c`,
        `documents/${ext}_c.pdf`,
      ],
    )
    docA = rows[0].id
    docB = rows[1].id
    docC = rows[2].id
  })

  // Each test inserts its own relation rows on the shared docs; clean the
  // slate between tests so the undirected pair index doesn't block a re-insert
  // of the same pair by the next test. (afterAll handles the final teardown.)
  beforeEach(async () => {
    await AppDataSource.query(
      `DELETE FROM document_relations WHERE document_id IN ($1, $2, $3) OR related_document_id IN ($1, $2, $3)`,
      [docA, docB, docC],
    )
  })

  afterAll(async () => {
    if (createdRelIds.length) {
      await AppDataSource.query(
        `DELETE FROM audit_log WHERE entity_type = 'document_relation' AND entity_id = ANY($1::uuid[])`,
        [createdRelIds],
      )
    }
    await AppDataSource.query(
      `DELETE FROM document_relations WHERE document_id IN ($1, $2, $3) OR related_document_id IN ($1, $2, $3)`,
      [docA, docB, docC],
    )
    await AppDataSource.query(
      `DELETE FROM documents WHERE id IN ($1, $2, $3)`,
      [docA, docB, docC],
    )
    await AppDataSource.destroy()
  })

  it('confirming a second confirmed edge for the same translation returns a conflict', async () => {
    // A->B suggested; A->C already confirmed. Confirming A->B would give A two
    // confirmed translation_of edges.
    const [ab] = await AppDataSource.query(
      `INSERT INTO document_relations (document_id, related_document_id, source, status, signals)
       VALUES ($1, $2, 'system', 'suggested', '{}') RETURNING id`,
      [docA, docB],
    )
    createdRelIds.push(ab.id)
    await AppDataSource.query(
      `INSERT INTO document_relations (document_id, related_document_id, source, status, signals)
       VALUES ($1, $2, 'human', 'confirmed', '{}') RETURNING id`,
      [docA, docC],
    )
    createdRelIds.push(
      (
        await AppDataSource.query(
          `SELECT id FROM document_relations WHERE document_id = $1 AND related_document_id = $2`,
          [docA, docC],
        )
      )[0].id,
    )

    const res = await reviewRelation(ab.id, 'confirm', 'tester')
    expect(res).toEqual({ conflict: true, reason: 'already_confirmed' })
  })

  it('flipping a confirmed edge onto a doc that already has one returns a conflict', async () => {
    // Confirmed A->B (A translation of B) AND confirmed B->C (B translation of C).
    // Flipping A->B -> B->A makes B a translation of both A and C -> two confirmed
    // edges on document_id=B.
    const [ab] = await AppDataSource.query(
      `INSERT INTO document_relations (document_id, related_document_id, source, status, signals)
       VALUES ($1, $2, 'human', 'confirmed', '{}') RETURNING id`,
      [docA, docB],
    )
    createdRelIds.push(ab.id)
    const [bc] = await AppDataSource.query(
      `INSERT INTO document_relations (document_id, related_document_id, source, status, signals)
       VALUES ($1, $2, 'human', 'confirmed', '{}') RETURNING id`,
      [docB, docC],
    )
    createdRelIds.push(bc.id)

    const res = await reviewRelation(ab.id, 'flip', 'tester')
    expect(res).toEqual({ conflict: true, reason: 'already_confirmed' })
  })

  it('createManual for an existing pair returns a pair_exists conflict', async () => {
    // A->B suggested already; manual-create A->B confirmed hits the undirected
    // pair unique index.
    const [ab] = await AppDataSource.query(
      `INSERT INTO document_relations (document_id, related_document_id, source, status, signals)
       VALUES ($1, $2, 'system', 'suggested', '{}') RETURNING id`,
      [docA, docB],
    )
    createdRelIds.push(ab.id)

    const res = await createManualRelation(docA, docB, 'tester')
    expect(res).toEqual({ conflict: true, reason: 'pair_exists' })
  })

  it('createManual for a translation that already has a confirmed edge returns already_confirmed', async () => {
    // A->C confirmed; manual-create A->B confirmed -> A would have two confirmed
    // edges. (A,B) is a fresh pair, so the confirmed constraint fires, not the pair.
    const [ac] = await AppDataSource.query(
      `INSERT INTO document_relations (document_id, related_document_id, source, status, signals)
       VALUES ($1, $2, 'human', 'confirmed', '{}') RETURNING id`,
      [docA, docC],
    )
    createdRelIds.push(ac.id)

    const res = await createManualRelation(docA, docB, 'tester')
    expect(res).toEqual({ conflict: true, reason: 'already_confirmed' })
  })
})
