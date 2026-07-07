/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import {
  listTagsWithCounts,
  createTag,
  deleteTagIfUnused,
  decideDocumentTag,
  addHumanTag,
  renameTag,
} from '@/db/queries/tagsAdmin'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip
const identity = { kind: 'token', role: 'admin' } as const

d('tagsAdmin (DB integration)', () => {
  const externalId = `tagsadmin_test_${Date.now()}`
  let docId: string
  let tagId: string

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const [docRow] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Tags Admin Test', 'needs_review') RETURNING id`,
      [externalId, `documents/${externalId}.pdf`],
    )
    docId = docRow.id

    const [tagRow] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('topic', '__test_value__', 'v1') RETURNING id`,
    )
    tagId = tagRow.id
  })

  afterAll(async () => {
    await AppDataSource.query(
      `DELETE FROM audit_log WHERE entity_id = $1 OR entity_id = $2`,
      [docId, tagId],
    )
    await AppDataSource.query(`DELETE FROM document_tags WHERE document_id = $1`, [docId])
    await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    await AppDataSource.query(`DELETE FROM tags WHERE id = $1`, [tagId])
    await AppDataSource.destroy()
  })

  it('listTagsWithCounts returns rows with expected shape', async () => {
    const tags = await listTagsWithCounts()
    expect(Array.isArray(tags)).toBe(true)
    // Our fabricated tag should appear
    const found = tags.find((t) => t.id === tagId)
    expect(found).toBeDefined()
    expect(found).toMatchObject({
      id: tagId,
      facet: 'topic',
      valueId: '__test_value__',
      taxonomyVersion: 'v1',
      acceptedCount: 0,
      suggestedCount: 0,
    })
  })

  it('createTag returns conflict on duplicate', async () => {
    // The tag with facet=topic, value_id=__test_value__, taxonomyVersion=v1 already exists
    const result = await createTag('topic', '__test_value__', identity)
    expect(result).toHaveProperty('error', 'tag already exists')
  })

  it('deleteTagIfUnused refuses when tag is applied to a document', async () => {
    // Add the tag to the doc first
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, status)
       VALUES ($1, $2, 'llm', 'suggested')`,
      [docId, tagId],
    )
    const result = await deleteTagIfUnused(tagId, identity)
    expect(result).toMatchObject({ deleted: false, reason: 'in_use' })
    if (!result.deleted) expect(result.error).toMatch(/document/)
  })

  it('deleteTagIfUnused reports not_found for an unknown tag id', async () => {
    const result = await deleteTagIfUnused('00000000-0000-4000-8000-000000000000', identity)
    expect(result).toMatchObject({ deleted: false, reason: 'not_found' })
  })

  it('decideDocumentTag flips status AND source to human, audit before preserves llm row', async () => {
    // document_tag row already exists from previous test (source='llm', status='suggested')
    const result = await decideDocumentTag(docId, tagId, 'accepted', identity)
    expect(result).toEqual({ ok: true })

    // Verify the row was updated
    const [row] = await AppDataSource.query(
      `SELECT source, status FROM document_tags WHERE document_id = $1 AND tag_id = $2`,
      [docId, tagId],
    )
    expect(row.source).toBe('human')
    expect(row.status).toBe('accepted')

    // Verify audit before preserved the llm row
    const [audit] = await AppDataSource.query(
      `SELECT action, before, after FROM audit_log
       WHERE entity_type = 'document' AND entity_id = $1
       ORDER BY at DESC LIMIT 1`,
      [docId],
    )
    expect(audit.action).toBe('tag_decision')
    expect(audit.before).toMatchObject({ tagId, source: 'llm', status: 'suggested' })
    expect(audit.after).toEqual({ tagId, status: 'accepted', source: 'human' })
  })

  it('deleteTagIfUnused succeeds when tag is not in use (uses a new spare tag)', async () => {
    const [spareRow] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('topic', '__test_spare__', 'v1') RETURNING id`,
    )
    const spareId = spareRow.id
    const result = await deleteTagIfUnused(spareId, identity)
    expect(result).toEqual({ deleted: true })
    // Confirm it is actually gone
    const rows = await AppDataSource.query(`SELECT id FROM tags WHERE id = $1`, [spareId])
    expect(rows).toHaveLength(0)
    // Clean up audit for spare tag
    await AppDataSource.query(`DELETE FROM audit_log WHERE entity_id = $1`, [spareId])
  })

  it('addHumanTag conflicts when tag is already on document', async () => {
    // document_tag row still exists from decideDocumentTag test
    const result = await addHumanTag(docId, tagId, identity)
    expect(result).toHaveProperty('error', 'tag already on document — use accept/reject')
  })

  it('addHumanTag inserts a new human tag', async () => {
    // Remove the existing doc_tag so we can re-add via addHumanTag
    await AppDataSource.query(
      `DELETE FROM document_tags WHERE document_id = $1 AND tag_id = $2`,
      [docId, tagId],
    )
    const result = await addHumanTag(docId, tagId, identity)
    expect(result).toEqual({ ok: true })

    const [row] = await AppDataSource.query(
      `SELECT source, status FROM document_tags WHERE document_id = $1 AND tag_id = $2`,
      [docId, tagId],
    )
    expect(row.source).toBe('human')
    expect(row.status).toBe('accepted')
  })

  it('removeDocumentTag physically deletes the document_tags row', async () => {
    // The tag is currently on the doc from the addHumanTag test
    const { removeDocumentTag } = await import('@/db/queries/tagsAdmin')
    const result = await removeDocumentTag(docId, tagId, identity)
    expect(result).toEqual({ ok: true })

    const rows = await AppDataSource.query(
      `SELECT 1 FROM document_tags WHERE document_id = $1 AND tag_id = $2`,
      [docId, tagId],
    )
    expect(rows).toHaveLength(0)

    // Verify audit row was written
    const [audit] = await AppDataSource.query(
      `SELECT action, before FROM audit_log
       WHERE entity_type = 'document' AND entity_id = $1
       ORDER BY at DESC LIMIT 1`,
      [docId],
    )
    expect(audit.action).toBe('tag_decision')
    expect(audit.before).toMatchObject({ tagId })
  })

  it('renameTag updates the valueId and writes an audit row with before/after', async () => {
    const ts = Date.now()
    // Create a spare tag to rename (the main tag still has document_tags rows)
    const [spareRow] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('topic', $1, 'v1') RETURNING id`,
      [`__test_rename_target_${ts}__`],
    )
    const spareId = spareRow.id

    const result = await renameTag(spareId, { valueId: `__test_renamed_${ts}__` }, identity)
    expect(result).not.toBeNull()
    expect(result!.valueId).toBe(`__test_renamed_${ts}__`)

    // Verify the DB row was updated
    const [row] = await AppDataSource.query(
      `SELECT facet, value_id FROM tags WHERE id = $1`,
      [spareId],
    )
    expect(row.value_id).toBe(`__test_renamed_${ts}__`)
    expect(row.facet).toBe('topic') // unchanged

    // Verify audit row
    const [audit] = await AppDataSource.query(
      `SELECT action, before, after FROM audit_log
       WHERE entity_type = 'tag' AND entity_id = $1
       ORDER BY at DESC LIMIT 1`,
      [spareId],
    )
    expect(audit.action).toBe('update')
    expect(audit.before).toMatchObject({ valueId: `__test_rename_target_${ts}__` })
    expect(audit.after).toMatchObject({ valueId: `__test_renamed_${ts}__` })

    // Cleanup
    await AppDataSource.query(`DELETE FROM audit_log WHERE entity_id = $1`, [spareId])
    await AppDataSource.query(`DELETE FROM tags WHERE id = $1`, [spareId])
  })

  it('renameTag updates the facet and writes an audit row', async () => {
    const ts = Date.now()
    const [spareRow] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('topic', $1, 'v1') RETURNING id`,
      [`__test_facet_rename_${ts}__`],
    )
    const spareId = spareRow.id

    const result = await renameTag(spareId, { facet: 'program' }, identity)
    expect(result).not.toBeNull()
    expect(result!.facet).toBe('program')

    const [row] = await AppDataSource.query(
      `SELECT facet FROM tags WHERE id = $1`,
      [spareId],
    )
    expect(row.facet).toBe('program')

    const [audit] = await AppDataSource.query(
      `SELECT before, after FROM audit_log
       WHERE entity_type = 'tag' AND entity_id = $1
       ORDER BY at DESC LIMIT 1`,
      [spareId],
    )
    expect(audit.before).toMatchObject({ facet: 'topic' })
    expect(audit.after).toMatchObject({ facet: 'program' })

    await AppDataSource.query(`DELETE FROM audit_log WHERE entity_id = $1`, [spareId])
    await AppDataSource.query(`DELETE FROM tags WHERE id = $1`, [spareId])
  })

  it('renameTag returns null for a non-existent tag', async () => {
    const result = await renameTag('00000000-0000-4000-8000-000000000000', { valueId: 'x' }, identity)
    expect(result).toBeNull()
  })

  it('renameTag validates non-empty valueId', async () => {
    const ts = Date.now()
    const [spareRow] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('topic', $1, 'v1') RETURNING id`,
      [`__test_empty_validate_${ts}__`],
    )
    const spareId = spareRow.id

    const result = await renameTag(spareId, { valueId: '   ' }, identity)
    expect(result).toHaveProperty('error')

    await AppDataSource.query(`DELETE FROM tags WHERE id = $1`, [spareId])
  })
})
