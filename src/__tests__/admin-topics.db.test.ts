/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import {
  listTopicsWithCounts,
  getTopic,
  createTopic,
  updateTopic,
  deleteTopicIfUnused,
  mergeTags,
} from '@/db/queries/topicsAdmin'
import type { AdminIdentity } from '@/lib/auth/identity'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

const adminIdentity: AdminIdentity = { kind: 'token', role: 'admin' }

d('topicsAdmin list/get (DB integration)', () => {
  let rootId: string
  let childId: string
  let nonTopicId: string
  const ids: string[] = []

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()

    // Create a root topic tag with a description and an alias
    const [rootRow] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version, description)
       VALUES ('topic', '__test_root__', 'v1', 'root desc') RETURNING id`,
    )
    rootId = rootRow.id
    ids.push(rootId)

    await AppDataSource.query(
      `INSERT INTO tag_aliases (tag_id, alias) VALUES ($1, '__test_alias__')`,
      [rootId],
    )

    // Create a child topic tag (parent = root), no aliases
    const [childRow] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version, parent_tag_id)
       VALUES ('topic', '__test_child__', 'v1', $1) RETURNING id`,
      [rootId],
    )
    childId = childRow.id
    ids.push(childId)

    // Create a non-topic tag (facet='program') to verify getTopic is topic-scoped
    const [nonTopicRow] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('program', '__test_program__', 'v1') RETURNING id`,
    )
    nonTopicId = nonTopicRow.id
    ids.push(nonTopicId)
  })

  afterAll(async () => {
    // Delete aliases first (FK references tags), then tags, then audit
    await AppDataSource.query(
      `DELETE FROM tag_aliases WHERE tag_id = ANY($1::uuid[])`,
      [ids],
    )
    await AppDataSource.query(
      `DELETE FROM tags WHERE id = ANY($1::uuid[])`,
      [ids],
    )
    await AppDataSource.destroy()
  })

  it('listTopicsWithCounts returns topic rows with aliases + parentTagId', async () => {
    const rows = await listTopicsWithCounts()
    expect(Array.isArray(rows)).toBe(true)

    const root = rows.find((t) => t.id === rootId)
    expect(root).toBeDefined()
    expect(root).toMatchObject({
      facet: 'topic',
      valueId: '__test_root__',
      taxonomyVersion: 'v1',
      description: 'root desc',
      parentTagId: null,
      acceptedCount: 0,
      suggestedCount: 0,
    })
    expect(root!.aliases).toContain('__test_alias__')

    const child = rows.find((t) => t.id === childId)
    expect(child).toBeDefined()
    expect(child!.parentTagId).toBe(rootId)
    expect(child!.aliases).toEqual([])
  })

  it('getTopic returns single tag with aliases and parent', async () => {
    const t = await getTopic(childId)
    expect(t).toBeDefined()
    expect(t).toMatchObject({
      id: childId,
      valueId: '__test_child__',
      parentTagId: rootId,
      acceptedCount: 0,
      suggestedCount: 0,
    })
    expect(t!.aliases).toEqual([])

    // Root tag should have the alias
    const root = await getTopic(rootId)
    expect(root!.aliases).toContain('__test_alias__')
    expect(root!.parentTagId).toBeNull()
    expect(root!.description).toBe('root desc')
  })

  it('getTopic returns null for a non-existent id', async () => {
    const t = await getTopic('00000000-0000-4000-8000-000000000000')
    expect(t).toBeNull()
  })

  it('getTopic returns null for a non-topic facet tag (topic-scoped filter)', async () => {
    const t = await getTopic(nonTopicId)
    expect(t).toBeNull()
  })

  // --- Task 3: createTopic + updateTopic ---

  it('createTopic sets needs_reembed, writes aliases, and writes audit', async () => {
    const result = await createTopic(
      { valueId: '__test_create__', description: 'created desc', aliases: ['__c_alias1__', '__c_alias2__'] },
      adminIdentity,
    )
    // Guard: ensure we got a Tag back, not an error
    if ('error' in result) throw new Error(`createTopic returned error: ${result.error}`)
    const created = result as any
    ids.push(created.id)

    // needs_reembed must be true
    const [row] = await AppDataSource.query(
      `SELECT needs_reembed FROM tags WHERE id = $1`, [created.id],
    )
    expect(row.needs_reembed).toBe(true)

    // Aliases must be inserted
    const aliases: any[] = await AppDataSource.query(
      `SELECT alias FROM tag_aliases WHERE tag_id = $1 ORDER BY alias`, [created.id],
    )
    expect(aliases.map((a) => a.alias)).toEqual(['__c_alias1__', '__c_alias2__'])

    // Audit row must exist
    const [audit] = await AppDataSource.query(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'tag_create'`, [created.id],
    )
    expect(audit).toBeDefined()
  })

  it('updateTopic rejects a cycle A→B→A (root.parent = child where root is child\'s parent)', async () => {
    // rootId is parent of childId. Setting root.parent = child creates a cycle.
    const res = await updateTopic(rootId, { parentTagId: childId }, adminIdentity)
    expect(res).toEqual({ error: 'cycle' })

    // Verify root's parent was NOT changed
    const [row] = await AppDataSource.query(
      `SELECT parent_tag_id FROM tags WHERE id = $1`, [rootId],
    )
    expect(row.parent_tag_id).toBeNull()
  })

  it('updateTopic edits description + replaces aliases + sets needs_reembed', async () => {
    // Reset needs_reembed to false first so we can detect the flip
    await AppDataSource.query(
      `UPDATE tags SET needs_reembed = false WHERE id = $1`, [rootId],
    )

    await updateTopic(rootId, { description: 'changed desc', aliases: ['__new_alias__'] }, adminIdentity)

    const [row] = await AppDataSource.query(
      `SELECT description, needs_reembed FROM tags WHERE id = $1`, [rootId],
    )
    expect(row.description).toBe('changed desc')
    expect(row.needs_reembed).toBe(true)

    const aliases: any[] = await AppDataSource.query(
      `SELECT alias FROM tag_aliases WHERE tag_id = $1`, [rootId],
    )
    expect(aliases.map((a) => a.alias)).toEqual(['__new_alias__'])

    // Audit row must exist for the update
    const [audit] = await AppDataSource.query(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'tag_update'`, [rootId],
    )
    expect(audit).toBeDefined()
  })

  // --- Task 4: deleteTopicIfUnused + mergeTags ---

  it('deleteTopicIfUnused blocks a tag with children (reason: has_children)', async () => {
    const res = await deleteTopicIfUnused(rootId, adminIdentity)
    expect(res).toMatchObject({ deleted: false, reason: 'has_children' })

    // Verify root still exists
    const [row] = await AppDataSource.query(`SELECT 1 FROM tags WHERE id = $1`, [rootId])
    expect(row).toBeDefined()
  })

  it('deleteTopicIfUnused succeeds for an unused topic with no children', async () => {
    // Create a throwaway topic with no children and no docs
    const [tmp] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version) VALUES ('topic', $1, 'v1') RETURNING id`,
      [`__test_del_ok_${Date.now()}__`],
    )
    const tmpId = tmp.id

    const res = await deleteTopicIfUnused(tmpId, adminIdentity)
    expect(res).toMatchObject({ deleted: true })

    // Verify it's gone
    const [gone] = await AppDataSource.query(`SELECT 1 FROM tags WHERE id = $1`, [tmpId])
    expect(gone).toBeUndefined()

    // Clean up audit row
    await AppDataSource.query(`DELETE FROM audit_log WHERE entity_id = $1`, [tmpId])
  })

  it('mergeTags moves document_tags, deletes source, and re-parents children', async () => {
    // Ensure no stale document_tags on childId from prior runs
    await AppDataSource.query(`DELETE FROM document_tags WHERE tag_id = $1`, [childId])

    // Create a temporary document
    const [docRow] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Merge Test', 'needs_review') RETURNING id`,
      [`__merge_test_${Date.now()}__`, `documents/__merge_test_${Date.now()}__.pdf`],
    )
    const docId = docRow.id

    // Tag the doc with childId (the source tag we'll merge away)
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, status) VALUES ($1, $2, 'llm', 'accepted')`,
      [docId, childId],
    )

    // Merge child into root
    const res = await mergeTags(rootId, childId, adminIdentity)
    expect(res).toMatchObject({ ok: true, moved: 1 })

    // The doc_tag should now be on rootId
    const [moved] = await AppDataSource.query(
      `SELECT tag_id FROM document_tags WHERE document_id = $1`, [docId],
    )
    expect(moved.tag_id).toBe(rootId)

    // childId should be gone
    const [gone] = await AppDataSource.query(`SELECT 1 FROM tags WHERE id = $1`, [childId])
    expect(gone).toBeUndefined()

    // Audit row for the merge should exist
    const [audit] = await AppDataSource.query(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'tag_merge'`, [rootId],
    )
    expect(audit).toBeDefined()

    // Cleanup: delete the doc (cascades document_tags), then audit rows
    await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    await AppDataSource.query(`DELETE FROM audit_log WHERE entity_id = $1`, [rootId])
    // Remove childId from ids array — it's already deleted by merge
    const idx = ids.indexOf(childId)
    if (idx >= 0) ids.splice(idx, 1)
  })

  // --- Task 4 fix round: branch coverage tests ---

  it('mergeTags PK-conflict: doc on both tags → moved:0, one row on target, zero on source', async () => {
    // Create two fresh temp topic tags
    const [tagA] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version) VALUES ('topic', $1, 'v1') RETURNING id`,
      [`__test_pk_a_${Date.now()}__`],
    )
    const [tagB] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version) VALUES ('topic', $1, 'v1') RETURNING id`,
      [`__test_pk_b_${Date.now()}__`],
    )
    ids.push(tagA.id, tagB.id)

    // Create a temp doc and tag it with BOTH tags
    const [docRow] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'PK Conflict Test', 'needs_review') RETURNING id`,
      [`__pk_test_${Date.now()}__`, `documents/__pk_test_${Date.now()}__.pdf`],
    )
    const docId = docRow.id
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, status) VALUES ($1, $2, 'llm', 'accepted')`,
      [docId, tagA.id],
    )
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, status) VALUES ($1, $2, 'llm', 'accepted')`,
      [docId, tagB.id],
    )

    // Merge tagA into tagB — doc already on tagB, so 0 moved
    const res = await mergeTags(tagB.id, tagA.id, adminIdentity)
    expect(res).toMatchObject({ ok: true, moved: 0 })

    // Exactly one row on tagB for this doc
    const rows: any[] = await AppDataSource.query(
      `SELECT tag_id FROM document_tags WHERE document_id = $1`, [docId],
    )
    expect(rows.length).toBe(1)
    expect(rows[0].tag_id).toBe(tagB.id)

    // tagA should be deleted
    const [gone] = await AppDataSource.query(`SELECT 1 FROM tags WHERE id = $1`, [tagA.id])
    expect(gone).toBeUndefined()

    // Cleanup
    await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    await AppDataSource.query(`DELETE FROM audit_log WHERE entity_id = $1`, [tagB.id])
    const aIdx = ids.indexOf(tagA.id)
    if (aIdx >= 0) ids.splice(aIdx, 1)
  })

  it('deleteTopicIfUnused returns in_use for a tag with documents', async () => {
    // Create a temp topic tag + temp doc, tag the doc
    const [tmpTag] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version) VALUES ('topic', $1, 'v1') RETURNING id`,
      [`__test_inuse_${Date.now()}__`],
    )
    ids.push(tmpTag.id)
    const [docRow] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'In-Use Test', 'needs_review') RETURNING id`,
      [`__inuse_test_${Date.now()}__`, `documents/__inuse_test_${Date.now()}__.pdf`],
    )
    const docId = docRow.id
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, status) VALUES ($1, $2, 'llm', 'accepted')`,
      [docId, tmpTag.id],
    )

    const res = await deleteTopicIfUnused(tmpTag.id, adminIdentity)
    expect(res).toMatchObject({ deleted: false, reason: 'in_use' })

    // Tag should still exist
    const [still] = await AppDataSource.query(`SELECT 1 FROM tags WHERE id = $1`, [tmpTag.id])
    expect(still).toBeDefined()

    // Cleanup
    await AppDataSource.query(`DELETE FROM document_tags WHERE document_id = $1`, [docId])
    await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
  })

  it('deleteTopicIfUnused returns not_found for a non-existent id', async () => {
    const res = await deleteTopicIfUnused('00000000-0000-4000-8000-000000000000', adminIdentity)
    expect(res).toMatchObject({ deleted: false, reason: 'not_found' })
  })

  it('mergeTags rejects self-merge (into === from)', async () => {
    const res = await mergeTags(rootId, rootId, adminIdentity)
    expect(res).toEqual({ error: 'cannot merge a tag into itself' })
  })

  it('mergeTags rejects missing tags (non-existent id)', async () => {
    const fake = '00000000-0000-4000-8000-000000000000'
    const res = await mergeTags(rootId, fake, adminIdentity)
    expect(res).toEqual({ error: 'tag not found' })
  })
})
