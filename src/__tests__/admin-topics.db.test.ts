/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import {
  listTopicsWithCounts,
  getTopic,
  createTopic,
  updateTopic,
  deleteTopicIfUnused,
  mergeTags,
  enqueueReclassify,
  reclassifyStatus,
  parseTopicsCsv,
  importTopicsDiff,
  applyTopicsImport,
  exportTopicsCsv,
  rebuildTagEmbeddings,
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
    await AppDataSource.query(`DELETE FROM tags WHERE id = ANY($1::uuid[])`, [
      ids,
    ])
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
      needsReembed: false,
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
      {
        valueId: '__test_create__',
        description: 'created desc',
        aliases: ['__c_alias1__', '__c_alias2__'],
      },
      adminIdentity,
    )
    // Guard: ensure we got a Tag back, not an error
    if ('error' in result)
      throw new Error(`createTopic returned error: ${result.error}`)
    const created = result as any
    ids.push(created.id)

    // needs_reembed must be true
    const [row] = await AppDataSource.query(
      `SELECT needs_reembed FROM tags WHERE id = $1`,
      [created.id],
    )
    expect(row.needs_reembed).toBe(true)

    // Aliases must be inserted
    const aliases: any[] = await AppDataSource.query(
      `SELECT alias FROM tag_aliases WHERE tag_id = $1 ORDER BY alias`,
      [created.id],
    )
    expect(aliases.map((a) => a.alias)).toEqual([
      '__c_alias1__',
      '__c_alias2__',
    ])

    // Audit row must exist
    const [audit] = await AppDataSource.query(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'tag_create'`,
      [created.id],
    )
    expect(audit).toBeDefined()
  })

  it("updateTopic rejects a cycle A→B→A (root.parent = child where root is child's parent)", async () => {
    // rootId is parent of childId. Setting root.parent = child creates a cycle.
    const res = await updateTopic(
      rootId,
      { parentTagId: childId },
      adminIdentity,
    )
    expect(res).toEqual({ error: 'cycle' })

    // Verify root's parent was NOT changed
    const [row] = await AppDataSource.query(
      `SELECT parent_tag_id FROM tags WHERE id = $1`,
      [rootId],
    )
    expect(row.parent_tag_id).toBeNull()
  })

  it('updateTopic edits description + replaces aliases + sets needs_reembed', async () => {
    // Reset needs_reembed to false first so we can detect the flip
    await AppDataSource.query(
      `UPDATE tags SET needs_reembed = false WHERE id = $1`,
      [rootId],
    )

    await updateTopic(
      rootId,
      { description: 'changed desc', aliases: ['__new_alias__'] },
      adminIdentity,
    )

    const [row] = await AppDataSource.query(
      `SELECT description, needs_reembed FROM tags WHERE id = $1`,
      [rootId],
    )
    expect(row.description).toBe('changed desc')
    expect(row.needs_reembed).toBe(true)

    const aliases: any[] = await AppDataSource.query(
      `SELECT alias FROM tag_aliases WHERE tag_id = $1`,
      [rootId],
    )
    expect(aliases.map((a) => a.alias)).toEqual(['__new_alias__'])

    // Audit row must exist for the update
    const [audit] = await AppDataSource.query(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'tag_update'`,
      [rootId],
    )
    expect(audit).toBeDefined()
  })

  // --- Task 4: deleteTopicIfUnused + mergeTags ---

  it('deleteTopicIfUnused blocks a tag with children (reason: has_children)', async () => {
    const res = await deleteTopicIfUnused(rootId, adminIdentity)
    expect(res).toMatchObject({ deleted: false, reason: 'has_children' })

    // Verify root still exists
    const [row] = await AppDataSource.query(
      `SELECT 1 FROM tags WHERE id = $1`,
      [rootId],
    )
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
    const [gone] = await AppDataSource.query(
      `SELECT 1 FROM tags WHERE id = $1`,
      [tmpId],
    )
    expect(gone).toBeUndefined()

    // Clean up audit row
    await AppDataSource.query(`DELETE FROM audit_log WHERE entity_id = $1`, [
      tmpId,
    ])
  })

  it('mergeTags moves document_tags, deletes source, and re-parents children', async () => {
    // Ensure no stale document_tags on childId from prior runs
    await AppDataSource.query(`DELETE FROM document_tags WHERE tag_id = $1`, [
      childId,
    ])

    // Create a temporary document
    const [docRow] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Merge Test', 'needs_review') RETURNING id`,
      [
        `__merge_test_${Date.now()}__`,
        `documents/__merge_test_${Date.now()}__.pdf`,
      ],
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
      `SELECT tag_id FROM document_tags WHERE document_id = $1`,
      [docId],
    )
    expect(moved.tag_id).toBe(rootId)

    // childId should be gone
    const [gone] = await AppDataSource.query(
      `SELECT 1 FROM tags WHERE id = $1`,
      [childId],
    )
    expect(gone).toBeUndefined()

    // Audit row for the merge should exist
    const [audit] = await AppDataSource.query(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'tag_merge'`,
      [rootId],
    )
    expect(audit).toBeDefined()

    // Cleanup: delete the doc (cascades document_tags), then audit rows
    await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    await AppDataSource.query(`DELETE FROM audit_log WHERE entity_id = $1`, [
      rootId,
    ])
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
      `SELECT tag_id FROM document_tags WHERE document_id = $1`,
      [docId],
    )
    expect(rows.length).toBe(1)
    expect(rows[0].tag_id).toBe(tagB.id)

    // tagA should be deleted
    const [gone] = await AppDataSource.query(
      `SELECT 1 FROM tags WHERE id = $1`,
      [tagA.id],
    )
    expect(gone).toBeUndefined()

    // Cleanup
    await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    await AppDataSource.query(`DELETE FROM audit_log WHERE entity_id = $1`, [
      tagB.id,
    ])
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
      [
        `__inuse_test_${Date.now()}__`,
        `documents/__inuse_test_${Date.now()}__.pdf`,
      ],
    )
    const docId = docRow.id
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, status) VALUES ($1, $2, 'llm', 'accepted')`,
      [docId, tmpTag.id],
    )

    const res = await deleteTopicIfUnused(tmpTag.id, adminIdentity)
    expect(res).toMatchObject({ deleted: false, reason: 'in_use' })

    // Tag should still exist
    const [still] = await AppDataSource.query(
      `SELECT 1 FROM tags WHERE id = $1`,
      [tmpTag.id],
    )
    expect(still).toBeDefined()

    // Cleanup
    await AppDataSource.query(
      `DELETE FROM document_tags WHERE document_id = $1`,
      [docId],
    )
    await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
  })

  it('deleteTopicIfUnused returns not_found for a non-existent id', async () => {
    const res = await deleteTopicIfUnused(
      '00000000-0000-4000-8000-000000000000',
      adminIdentity,
    )
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

  // --- Task 5: enqueueReclassify + reclassifyStatus ---

  it('enqueueReclassify("all") returns {enqueued, estCost, runId} and is idempotent', async () => {
    // Create a temporary doc with status='ready' so enqueueReclassify picks it up
    const [docRow] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Reclassify Test', 'ready') RETURNING id`,
      [
        `__recls_test_${Date.now()}__`,
        `documents/__recls_test_${Date.now()}__.pdf`,
      ],
    )
    const docId = docRow.id
    let runId: string

    try {
      const r1 = await enqueueReclassify('all')
      runId = r1.runId
      expect(r1).toHaveProperty('enqueued')
      expect(r1).toHaveProperty('estCost')
      expect(r1).toHaveProperty('runId')
      expect(typeof r1.runId).toBe('string')
      expect(r1.enqueued).toBeGreaterThanOrEqual(1) // at least our ready doc
      expect(r1.estCost).toBe(+(r1.enqueued * 0.0008).toFixed(4))

      // Second call: all ready docs already queued → 0 new
      const r2 = await enqueueReclassify('all')
      expect(r2.enqueued).toBe(0)
      expect(r2.estCost).toBe(0)
      // runId should be different (new run, even if nothing enqueued)
      expect(r2.runId).not.toBe(r1.runId)
    } finally {
      // Cleanup: delete ALL jobs from this run (may include other ready docs), then the doc
      await AppDataSource.query(
        `DELETE FROM reclassify_jobs WHERE run_id = $1`,
        [runId],
      )
      await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    }
  })

  it('enqueueReclassify scoped to a tagId enqueues docs tagged with that tag (source=llm)', async () => {
    // Create a temp topic tag + temp doc + document_tag(source='llm')
    const [tagRow] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version) VALUES ('topic', $1, 'v1') RETURNING id`,
      [`__recls_tag_${Date.now()}__`],
    )
    const tagId = tagRow.id
    ids.push(tagId)
    const [docRow] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Scoped Reclassify Test', 'needs_review') RETURNING id`,
      [
        `__recls_scoped_${Date.now()}__`,
        `documents/__recls_scoped_${Date.now()}__.pdf`,
      ],
    )
    const docId = docRow.id
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, status) VALUES ($1, $2, 'llm', 'accepted')`,
      [docId, tagId],
    )

    try {
      const r = await enqueueReclassify({ tagId })
      expect(r.enqueued).toBe(1)
      expect(r.estCost).toBe(+(1 * 0.0008).toFixed(4))
      expect(typeof r.runId).toBe('string')

      // Verify the job row exists with the right scope_tag_id
      const [job] = await AppDataSource.query(
        `SELECT scope_tag_id, run_id FROM reclassify_jobs WHERE document_id = $1`,
        [docId],
      )
      expect(job.scope_tag_id).toBe(tagId)
      expect(job.run_id).toBe(r.runId)
    } finally {
      await AppDataSource.query(
        `DELETE FROM reclassify_jobs WHERE document_id = $1`,
        [docId],
      )
      await AppDataSource.query(
        `DELETE FROM document_tags WHERE document_id = $1`,
        [docId],
      )
      await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    }
  })

  it('reclassifyStatus returns counts and recent runs with full shape', async () => {
    // Seed a known job so recent[] is non-empty regardless of prior test cleanup
    const [docRow] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Status Test', 'ready') RETURNING id`,
      [
        `__recls_status_${Date.now()}__`,
        `documents/__recls_status_${Date.now()}__.pdf`,
      ],
    )
    const docId = docRow.id
    let runId: string

    try {
      const r = await enqueueReclassify('all')
      runId = r.runId
      expect(r.enqueued).toBeGreaterThanOrEqual(1)

      const s = await reclassifyStatus()
      expect(s).toHaveProperty('queued')
      expect(s).toHaveProperty('running')
      expect(s).toHaveProperty('done')
      expect(s).toHaveProperty('error')
      expect(s).toHaveProperty('recent')
      expect(Array.isArray(s.recent)).toBe(true)

      // Find our run in recent[] and assert the full shape (ungated)
      const entry = s.recent.find((rr) => rr.runId === runId)
      expect(entry).toBeDefined()
      expect(entry!).toHaveProperty('scope')
      expect(entry!.scope).toBe('all')
      expect(entry!).toHaveProperty('total')
      expect(entry!.total).toBeGreaterThanOrEqual(1)
      expect(entry!).toHaveProperty('done')
      expect(entry!).toHaveProperty('error')
      expect(entry!).toHaveProperty('estCost')
      expect(entry!.estCost).toBe(+(entry!.total * 0.0008).toFixed(4))
      expect(entry!).toHaveProperty('createdAt')
    } finally {
      await AppDataSource.query(
        `DELETE FROM reclassify_jobs WHERE run_id = $1`,
        [runId],
      )
      await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    }
  })

  // --- Task 6: CSV import (dry-run diff + atomic apply) + export ---

  it('parseTopicsCsv parses quoted fields with commas, pipe aliases, and embedded newlines', () => {
    const csv = [
      'label,description,aliases,parent,facet,id',
      '"Water, Sanitation, and Hygiene","A description",WASH|Sanitation,,topic,',
      'Coal,,Fossil|Energy,Water,topic,',
      '"Multi\nLine","desc with\nnewline",,,topic,',
    ].join('\n')
    const rows = parseTopicsCsv(csv)
    expect(rows.length).toBe(3)

    expect(rows[0].label).toBe('Water, Sanitation, and Hygiene')
    expect(rows[0].description).toBe('A description')
    expect(rows[0].aliases).toEqual(['WASH', 'Sanitation'])
    expect(rows[0].parent).toBe('')
    expect(rows[0].facet).toBe('topic')
    expect(rows[0].id).toBe('')

    expect(rows[1].label).toBe('Coal')
    expect(rows[1].description).toBe('')
    expect(rows[1].aliases).toEqual(['Fossil', 'Energy'])
    expect(rows[1].parent).toBe('Water')

    expect(rows[2].label).toBe('Multi\nLine')
    expect(rows[2].description).toBe('desc with\nnewline')
  })

  it('importTopicsDiff reports a conflict for a bad parent reference', async () => {
    const diff = await importTopicsDiff([
      {
        label: `__imp_bad_${Date.now()}__`,
        description: '',
        aliases: [],
        parent: 'NoSuchTopic',
        facet: 'topic',
        id: '',
      },
    ])
    expect(diff.conflicts.length).toBe(1)
    expect(diff.conflicts[0].reason).toContain('parent')
  })

  it('applyTopicsImport is atomic — throws on conflict and the good row was NOT inserted', async () => {
    const goodLabel = `__imp_good_${Date.now()}__`
    const rows = [
      {
        label: goodLabel,
        description: 'x',
        aliases: [],
        parent: '',
        facet: 'topic',
        id: '',
      },
      {
        label: `__imp_conflict_${Date.now()}__`,
        description: '',
        aliases: [],
        parent: 'NoSuchTopic',
        facet: 'topic',
        id: '',
      },
    ]
    await expect(applyTopicsImport(rows, false)).rejects.toThrow(/conflict/i)

    // Verify the good row was NOT inserted (rolled back / never started)
    const [gone] = await AppDataSource.query(
      `SELECT 1 FROM tags WHERE value_id = $1 AND facet = 'topic'`,
      [goodLabel],
    )
    expect(gone).toBeUndefined()
  })

  it('exportTopicsCsv round-trips through importTopicsDiff with 0 adds/updates/conflicts', async () => {
    const csv = await exportTopicsCsv()
    const rows = parseTopicsCsv(csv)
    const diff = await importTopicsDiff(rows)
    expect(diff.added.length).toBe(0)
    expect(diff.updated.length).toBe(0)
    expect(diff.conflicts.length).toBe(0)
  })

  it('applyTopicsImport sets parent_tag_id for forward-referencing child (child before parent in CSV)', async () => {
    const parentLabel = `__imp_fwd_parent_${Date.now()}__`
    const childLabel = `__imp_fwd_child_${Date.now()}__`
    const rows = [
      {
        label: childLabel,
        description: '',
        aliases: [],
        parent: parentLabel,
        facet: 'topic',
        id: '',
      },
      {
        label: parentLabel,
        description: 'the parent',
        aliases: [],
        parent: '',
        facet: 'topic',
        id: '',
      },
    ]
    await applyTopicsImport(rows, false)

    const [parentRow] = await AppDataSource.query(
      `SELECT id FROM tags WHERE value_id = $1 AND facet = 'topic'`,
      [parentLabel],
    )
    const [childRow] = await AppDataSource.query(
      `SELECT parent_tag_id FROM tags WHERE value_id = $1 AND facet = 'topic'`,
      [childLabel],
    )
    expect(parentRow).toBeDefined()
    expect(childRow).toBeDefined()
    expect(childRow.parent_tag_id).toBe(parentRow.id)

    // cleanup
    await AppDataSource.query(
      `DELETE FROM tag_aliases WHERE tag_id IN (SELECT id FROM tags WHERE value_id IN ($1, $2))`,
      [childLabel, parentLabel],
    )
    await AppDataSource.query(
      `DELETE FROM tags WHERE value_id IN ($1, $2) AND facet = 'topic'`,
      [childLabel, parentLabel],
    )
  })

  it('rebuildTagEmbeddings sets needs_reembed and writes a tag_embeddings_rebuild audit row', async () => {
    // Fresh topic tag with needs_reembed=false and no embedding row → eligible for rebuild
    const label = `__imp_rebuild_${Date.now()}__`
    const [tagRow] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version, description, needs_reembed)
       VALUES ('topic', $1, 'v1', 'rebuild test', false) RETURNING id`,
      [label],
    )
    const tagId = tagRow.id
    try {
      const { queued } = await rebuildTagEmbeddings(adminIdentity)
      expect(queued).toBeGreaterThanOrEqual(1)

      // Our tag must now have needs_reembed=true
      const [row] = await AppDataSource.query(
        `SELECT needs_reembed FROM tags WHERE id = $1`,
        [tagId],
      )
      expect(row.needs_reembed).toBe(true)

      // Audit row must exist for the rebuild (entityId is null — query by action)
      const [audit] = await AppDataSource.query(
        `SELECT action FROM audit_log WHERE action = 'tag_embeddings_rebuild' ORDER BY at DESC LIMIT 1`,
      )
      expect(audit).toBeDefined()
      expect(audit.action).toBe('tag_embeddings_rebuild')
    } finally {
      await AppDataSource.query(
        `DELETE FROM audit_log WHERE action = 'tag_embeddings_rebuild'`,
      )
      await AppDataSource.query(`DELETE FROM tags WHERE id = $1`, [tagId])
    }
  })

  it('applyTopicsImport rejects a cyclic parent assignment (A→B, B→A) and rolls back', async () => {
    const labelA = `__imp_cyc_a_${Date.now()}__`
    const labelB = `__imp_cyc_b_${Date.now()}__`
    const rows = [
      {
        label: labelA,
        description: '',
        aliases: [],
        parent: labelB,
        facet: 'topic',
        id: '',
      },
      {
        label: labelB,
        description: '',
        aliases: [],
        parent: labelA,
        facet: 'topic',
        id: '',
      },
    ]
    await expect(applyTopicsImport(rows, false)).rejects.toThrow(/cycle/i)

    // Neither tag should exist (transaction rolled back)
    const left: any[] = await AppDataSource.query(
      `SELECT 1 FROM tags WHERE value_id IN ($1, $2) AND facet = 'topic'`,
      [labelA, labelB],
    )
    expect(left.length).toBe(0)
  })
})

d(
  'topicsAdmin transaction-aware audit and parent validation (DB integration)',
  () => {
    const runId = crypto.randomUUID()
    const labels = {
      parent: `__task1_parent_${runId}__`,
      program: `__task1_program_${runId}__`,
      legacy: `__task1_legacy_${runId}__`,
      create: `__task1_create_${runId}__`,
      audited: `__task1_audited_${runId}__`,
    }
    const tagIds: string[] = []
    let identity: AdminIdentity
    let actorUserId: string

    beforeAll(async () => {
      if (!AppDataSource.isInitialized) await AppDataSource.initialize()

      const [actor] = await AppDataSource.query(
        `INSERT INTO users (username, password_hash, role)
       VALUES ($1, 'not-used-by-test', 'admin') RETURNING id`,
        [`task1-audit-${runId}`],
      )
      actorUserId = actor.id
      identity = {
        kind: 'user',
        userId: actorUserId,
        username: `task1-audit-${runId}`,
        role: 'admin',
      }

      const [parent] = await AppDataSource.query(
        `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('topic', $1, 'v1') RETURNING id`,
        [labels.parent],
      )
      const [program] = await AppDataSource.query(
        `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('program', $1, 'v1') RETURNING id`,
        [labels.program],
      )
      const [legacy] = await AppDataSource.query(
        `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('topic', $1, 'v2') RETURNING id`,
        [labels.legacy],
      )
      tagIds.push(parent.id, program.id, legacy.id)
    })

    afterAll(async () => {
      await AppDataSource.query(
        `DELETE FROM audit_log WHERE actor_user_id = $1 AND entity_id = ANY($2::uuid[])`,
        [actorUserId, tagIds],
      )
      await AppDataSource.query(
        `DELETE FROM tag_aliases WHERE tag_id = ANY($1::uuid[])`,
        [tagIds],
      )
      await AppDataSource.query(`DELETE FROM tags WHERE id = ANY($1::uuid[])`, [
        tagIds,
      ])
      await AppDataSource.query(`DELETE FROM users WHERE id = $1`, [
        actorUserId,
      ])
      await AppDataSource.destroy()
    })

    it('create rejects a non-topic parent and returns a camel-case valueId', async () => {
      const [program] = await AppDataSource.query(
        `SELECT id FROM tags WHERE facet = 'program' AND value_id = $1 AND taxonomy_version = 'v1'`,
        [labels.program],
      )

      await expect(
        createTopic(
          { valueId: labels.create, parentTagId: program.id },
          identity,
        ),
      ).resolves.toEqual({ error: 'parent must be a v1 topic' })

      const created = await createTopic({ valueId: labels.create }, identity)
      expect(created).toMatchObject({ valueId: labels.create })
      if (!('error' in created)) tagIds.push(created.id)
    })

    it('update rejects a non-v1 parent', async () => {
      const [parent] = await AppDataSource.query(
        `SELECT id FROM tags WHERE facet = 'topic' AND value_id = $1 AND taxonomy_version = 'v1'`,
        [labels.parent],
      )
      const [legacy] = await AppDataSource.query(
        `SELECT id FROM tags WHERE facet = 'topic' AND value_id = $1 AND taxonomy_version = 'v2'`,
        [labels.legacy],
      )

      await expect(
        updateTopic(parent.id, { parentTagId: legacy.id }, identity),
      ).resolves.toEqual({ error: 'parent must be a v1 topic' })
    })

    it('writes the topic audit in the topic mutation transaction', async () => {
      const suffix = runId.replaceAll('-', '')
      const tagFunction = `task1_tag_txid_${suffix}`
      const auditFunction = `task1_audit_txid_${suffix}`
      const tagTrigger = `task1_tag_txid_trigger_${suffix}`
      const auditTrigger = `task1_audit_txid_trigger_${suffix}`

      await AppDataSource.query(
        `CREATE FUNCTION ${tagFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         NEW.description := COALESCE(NEW.description, '') || '__task1_txid=' || txid_current()::text;
         RETURN NEW;
       END;
       $$`,
      )
      await AppDataSource.query(
        `CREATE FUNCTION ${auditFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         NEW.after := COALESCE(NEW.after, '{}'::jsonb)
           || jsonb_build_object('__task1_txid', txid_current()::text);
         RETURN NEW;
       END;
       $$`,
      )
      await AppDataSource.query(
        `CREATE TRIGGER ${tagTrigger} BEFORE INSERT ON tags
       FOR EACH ROW EXECUTE FUNCTION ${tagFunction}()`,
      )
      await AppDataSource.query(
        `CREATE TRIGGER ${auditTrigger} BEFORE INSERT ON audit_log
       FOR EACH ROW EXECUTE FUNCTION ${auditFunction}()`,
      )

      try {
        const created = await createTopic({ valueId: labels.audited }, identity)
        if ('error' in created)
          throw new Error(`createTopic returned error: ${created.error}`)
        tagIds.push(created.id)

        const [row] = await AppDataSource.query(
          `SELECT t.description, a.after->>'__task1_txid' AS audit_txid
         FROM tags t
         JOIN audit_log a ON a.entity_id = t.id
         WHERE t.id = $1 AND a.actor_user_id = $2 AND a.action = 'tag_create'`,
          [created.id, actorUserId],
        )
        expect(row.description).toBe(`__task1_txid=${row.audit_txid}`)
      } finally {
        await AppDataSource.query(
          `DROP TRIGGER IF EXISTS ${tagTrigger} ON tags`,
        )
        await AppDataSource.query(
          `DROP TRIGGER IF EXISTS ${auditTrigger} ON audit_log`,
        )
        await AppDataSource.query(`DROP FUNCTION IF EXISTS ${tagFunction}()`)
        await AppDataSource.query(`DROP FUNCTION IF EXISTS ${auditFunction}()`)
      }
    })
  },
)

d('topicsAdmin guarded merge integrity (DB integration)', () => {
  const runId = crypto.randomUUID()
  const suffix = runId.replaceAll('-', '')
  const tagIds: string[] = []
  const documentIds: string[] = []

  async function insertTag(
    label: string,
    options: {
      facet?: string
      taxonomyVersion?: string
      parentTagId?: string | null
    } = {},
  ): Promise<string> {
    const [tag] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version, parent_tag_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        options.facet ?? 'topic',
        `__task2_${label}_${runId}__`,
        options.taxonomyVersion ?? 'v1',
        options.parentTagId ?? null,
      ],
    )
    tagIds.push(tag.id)
    return tag.id
  }

  async function insertDocument(label: string): Promise<string> {
    const [document] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, $3, 'ready') RETURNING id`,
      [
        `__task2_${label}_${runId}__`,
        `documents/__task2_${label}_${runId}__.pdf`,
        `Task 2 ${label}`,
      ],
    )
    documentIds.push(document.id)
    return document.id
  }

  async function assign(
    documentId: string,
    tagId: string,
    source: 'llm' | 'human' | 'external',
    status: 'accepted' | 'suggested',
    confidence: number,
    modelVersion: string,
  ): Promise<void> {
    await AppDataSource.query(
      `INSERT INTO document_tags
         (document_id, tag_id, source, status, confidence, model_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [documentId, tagId, source, status, confidence, modelVersion],
    )
  }

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })

  afterAll(async () => {
    if (documentIds.length > 0) {
      await AppDataSource.query(
        `DELETE FROM reclassify_jobs WHERE document_id = ANY($1::uuid[])`,
        [documentIds],
      )
      await AppDataSource.query(
        `DELETE FROM document_tags WHERE document_id = ANY($1::uuid[])`,
        [documentIds],
      )
      await AppDataSource.query(
        `DELETE FROM documents WHERE id = ANY($1::uuid[])`,
        [documentIds],
      )
    }
    if (tagIds.length > 0) {
      await AppDataSource.query(
        `DELETE FROM audit_log WHERE entity_id = ANY($1::uuid[])`,
        [tagIds],
      )
      await AppDataSource.query(
        `DELETE FROM tag_aliases WHERE tag_id = ANY($1::uuid[])`,
        [tagIds],
      )
      await AppDataSource.query(`DELETE FROM tags WHERE id = ANY($1::uuid[])`, [
        tagIds,
      ])
    }
    await AppDataSource.destroy()
  })

  it('rejects a cross-facet source without changing either tag', async () => {
    const targetId = await insertTag('cross_facet_target')
    const programId = await insertTag('cross_facet_source', {
      facet: 'program',
    })

    await expect(
      mergeTags(targetId, programId, adminIdentity),
    ).resolves.toEqual({ error: 'tag not found' })

    const remaining: any[] = await AppDataSource.query(
      `SELECT id FROM tags WHERE id = ANY($1::uuid[])`,
      [[targetId, programId]],
    )
    expect(remaining).toHaveLength(2)
  })

  it('rejects merging an ancestor topic into its descendant', async () => {
    const ancestorId = await insertTag('ancestor')
    const descendantId = await insertTag('descendant', {
      parentTagId: ancestorId,
    })

    await expect(
      mergeTags(descendantId, ancestorId, adminIdentity),
    ).resolves.toEqual({
      error: 'cannot merge a topic into its descendant',
    })

    const [descendant] = await AppDataSource.query(
      `SELECT parent_tag_id FROM tags WHERE id = $1`,
      [descendantId],
    )
    expect(descendant.parent_tag_id).toBe(ancestorId)
  })

  it('rejects a merge when the source has children outside topic/v1', async () => {
    const targetId = await insertTag('scoped_child_target')
    const sourceId = await insertTag('scoped_child_source')
    const programChildId = await insertTag('scoped_program_child', {
      facet: 'program',
      parentTagId: sourceId,
    })
    const v2ChildId = await insertTag('scoped_v2_child', {
      taxonomyVersion: 'v2',
      parentTagId: sourceId,
    })

    await expect(mergeTags(targetId, sourceId, adminIdentity)).resolves.toEqual(
      {
        error: 'cannot merge a topic with out-of-scope children',
      },
    )

    const dependents: any[] = await AppDataSource.query(
      `SELECT id, parent_tag_id FROM tags WHERE id = ANY($1::uuid[])`,
      [[sourceId, programChildId, v2ChildId]],
    )
    expect(dependents).toHaveLength(3)
    expect(
      dependents
        .filter((tag) => tag.id !== sourceId)
        .every((tag) => tag.parent_tag_id === sourceId),
    ).toBe(true)
  })

  it('transfers source aliases and atomically enqueues affected documents', async () => {
    const targetId = await insertTag('alias_target')
    const sourceId = await insertTag('alias_source')
    const documentId = await insertDocument('alias_transfer')
    const sourceAlias = `__task2_source_alias_${runId}__`
    await AppDataSource.query(
      `INSERT INTO tag_aliases (tag_id, alias) VALUES ($1, $2)`,
      [sourceId, sourceAlias],
    )
    await assign(documentId, sourceId, 'llm', 'accepted', 0.7, 'merge-old')

    const result = await mergeTags(targetId, sourceId, adminIdentity)

    const aliases: any[] = await AppDataSource.query(
      `SELECT alias FROM tag_aliases WHERE tag_id = $1`,
      [targetId],
    )
    expect(aliases.map((row) => row.alias)).toContain(sourceAlias)
    const [target] = await AppDataSource.query(
      `SELECT needs_reembed FROM tags WHERE id = $1`,
      [targetId],
    )
    expect(target.needs_reembed).toBe(true)

    const [job] = await AppDataSource.query(
      `SELECT document_id, scope_tag_id
       FROM reclassify_jobs WHERE document_id = $1`,
      [documentId],
    )
    expect(job).toMatchObject({
      document_id: documentId,
      scope_tag_id: targetId,
    })
    expect(result).toMatchObject({ ok: true, moved: 1, enqueued: 1 })
  })

  it('promotes human and external source assignments but retains protected targets', async () => {
    const targetId = await insertTag('precedence_target')
    const sourceId = await insertTag('precedence_source')
    const humanSourceDoc = await insertDocument('human_source')
    const externalSourceDoc = await insertDocument('external_source')
    const humanTargetDoc = await insertDocument('human_target')
    const externalTargetDoc = await insertDocument('external_target')

    await assign(
      humanSourceDoc,
      sourceId,
      'human',
      'accepted',
      0.91,
      'human-new',
    )
    await assign(humanSourceDoc, targetId, 'llm', 'suggested', 0.2, 'llm-old')
    await assign(
      externalSourceDoc,
      sourceId,
      'external',
      'accepted',
      0.83,
      'external-new',
    )
    await assign(
      externalSourceDoc,
      targetId,
      'llm',
      'suggested',
      0.3,
      'llm-old',
    )
    await assign(humanTargetDoc, sourceId, 'llm', 'suggested', 0.4, 'llm-new')
    await assign(
      humanTargetDoc,
      targetId,
      'human',
      'accepted',
      0.99,
      'human-existing',
    )
    await assign(
      externalTargetDoc,
      sourceId,
      'llm',
      'suggested',
      0.5,
      'llm-new',
    )
    await assign(
      externalTargetDoc,
      targetId,
      'external',
      'accepted',
      0.95,
      'external-existing',
    )

    const result = await mergeTags(targetId, sourceId, adminIdentity)

    const assignments: any[] = await AppDataSource.query(
      `SELECT document_id, source, status, confidence::float AS confidence,
              model_version
       FROM document_tags
       WHERE tag_id = $1 AND document_id = ANY($2::uuid[])
       ORDER BY document_id`,
      [
        targetId,
        [humanSourceDoc, externalSourceDoc, humanTargetDoc, externalTargetDoc],
      ],
    )
    const byDocument = new Map(assignments.map((row) => [row.document_id, row]))
    expect(byDocument.get(humanSourceDoc)).toMatchObject({
      source: 'human',
      status: 'accepted',
      confidence: 0.91,
      model_version: 'human-new',
    })
    expect(byDocument.get(externalSourceDoc)).toMatchObject({
      source: 'external',
      status: 'accepted',
      confidence: 0.83,
      model_version: 'external-new',
    })
    expect(byDocument.get(humanTargetDoc)).toMatchObject({
      source: 'human',
      status: 'accepted',
      confidence: 0.99,
      model_version: 'human-existing',
    })
    expect(byDocument.get(externalTargetDoc)).toMatchObject({
      source: 'external',
      status: 'accepted',
      confidence: 0.95,
      model_version: 'external-existing',
    })
    expect(result).toMatchObject({ ok: true, moved: 2, enqueued: 4 })
  })

  it('rolls back assignments, aliases, source deletion, audit, and jobs when merge enqueue fails', async () => {
    const targetId = await insertTag('enqueue_failure_target')
    const sourceId = await insertTag('enqueue_failure_source')
    const documentId = await insertDocument('merge_enqueue_failure')
    const sourceAlias = `__task2_rollback_alias_${runId}__`
    await AppDataSource.query(
      `INSERT INTO tag_aliases (tag_id, alias) VALUES ($1, $2)`,
      [sourceId, sourceAlias],
    )
    await assign(documentId, sourceId, 'llm', 'accepted', 0.75, 'merge-old')

    const enqueueFunction = `task2_merge_enqueue_fail_${suffix}`
    const enqueueTrigger = `task2_merge_enqueue_fail_trigger_${suffix}`
    await AppDataSource.query(
      `CREATE FUNCTION ${enqueueFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.document_id = '${documentId}'::uuid THEN
           RAISE EXCEPTION 'task2 merge enqueue failure';
         END IF;
         RETURN NEW;
       END;
       $$`,
    )
    await AppDataSource.query(
      `CREATE TRIGGER ${enqueueTrigger} BEFORE INSERT ON reclassify_jobs
       FOR EACH ROW EXECUTE FUNCTION ${enqueueFunction}()`,
    )

    let thrown: unknown
    try {
      await mergeTags(targetId, sourceId, adminIdentity)
    } catch (error) {
      thrown = error
    } finally {
      await AppDataSource.query(
        `DROP TRIGGER IF EXISTS ${enqueueTrigger} ON reclassify_jobs`,
      )
      await AppDataSource.query(`DROP FUNCTION IF EXISTS ${enqueueFunction}()`)
    }

    const tags: any[] = await AppDataSource.query(
      `SELECT id, needs_reembed FROM tags WHERE id = ANY($1::uuid[])`,
      [[targetId, sourceId]],
    )
    const assignments: any[] = await AppDataSource.query(
      `SELECT tag_id FROM document_tags WHERE document_id = $1`,
      [documentId],
    )
    const aliases: any[] = await AppDataSource.query(
      `SELECT tag_id, alias FROM tag_aliases WHERE alias = $1`,
      [sourceAlias],
    )
    const [job] = await AppDataSource.query(
      `SELECT id FROM reclassify_jobs WHERE document_id = $1`,
      [documentId],
    )
    const [audit] = await AppDataSource.query(
      `SELECT id FROM audit_log
       WHERE entity_id = $1 AND action = 'tag_merge'`,
      [targetId],
    )

    expect(thrown).toMatchObject({ name: 'QueryFailedError' })
    expect(tags).toHaveLength(2)
    expect(tags.find((tag) => tag.id === targetId)?.needs_reembed).toBe(false)
    expect(assignments).toEqual([{ tag_id: sourceId }])
    expect(aliases).toEqual([{ tag_id: sourceId, alias: sourceAlias }])
    expect(job).toBeUndefined()
    expect(audit).toBeUndefined()
  })
})

d('topicsAdmin CSV integrity and rollback (DB integration)', () => {
  const runId = crypto.randomUUID()
  const suffix = runId.replaceAll('-', '')
  const tagIds: string[] = []
  const documentIds: string[] = []
  let actorUserId: string
  let identity: AdminIdentity

  const row = (
    label: string,
    options: Partial<{
      description: string
      aliases: string[]
      parent: string
      facet: string
      id: string
    }> = {},
  ) => ({
    label,
    description: options.description ?? '',
    aliases: options.aliases ?? [],
    parent: options.parent ?? '',
    facet: options.facet ?? 'topic',
    id: options.id ?? '',
  })

  async function insertTag(
    label: string,
    options: {
      description?: string
      parentTagId?: string | null
    } = {},
  ): Promise<string> {
    const [tag] = await AppDataSource.query(
      `INSERT INTO tags
         (facet, value_id, taxonomy_version, description, parent_tag_id)
       VALUES ('topic', $1, 'v1', $2, $3) RETURNING id`,
      [label, options.description ?? null, options.parentTagId ?? null],
    )
    tagIds.push(tag.id)
    return tag.id
  }

  async function insertDocument(label: string): Promise<string> {
    const [document] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, $3, 'ready') RETURNING id`,
      [
        `__task2_csv_${label}_${runId}__`,
        `documents/__task2_csv_${label}_${runId}__.pdf`,
        `Task 2 CSV ${label}`,
      ],
    )
    documentIds.push(document.id)
    return document.id
  }

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const [actor] = await AppDataSource.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, 'not-used-by-test', 'admin') RETURNING id`,
      [`task2-csv-${runId}`],
    )
    actorUserId = actor.id
    identity = {
      kind: 'user',
      userId: actorUserId,
      username: `task2-csv-${runId}`,
      role: 'admin',
    }
  })

  afterAll(async () => {
    if (documentIds.length > 0) {
      await AppDataSource.query(
        `DELETE FROM reclassify_jobs WHERE document_id = ANY($1::uuid[])`,
        [documentIds],
      )
      await AppDataSource.query(
        `DELETE FROM document_tags WHERE document_id = ANY($1::uuid[])`,
        [documentIds],
      )
      await AppDataSource.query(
        `DELETE FROM documents WHERE id = ANY($1::uuid[])`,
        [documentIds],
      )
    }
    await AppDataSource.query(
      `DELETE FROM audit_log WHERE actor_user_id = $1`,
      [actorUserId],
    )
    if (tagIds.length > 0) {
      await AppDataSource.query(
        `DELETE FROM tag_aliases WHERE tag_id = ANY($1::uuid[])`,
        [tagIds],
      )
      await AppDataSource.query(`DELETE FROM tags WHERE id = ANY($1::uuid[])`, [
        tagIds,
      ])
    }
    await AppDataSource.query(`DELETE FROM users WHERE id = $1`, [actorUserId])
    await AppDataSource.destroy()
  })

  it('resolves a child parent from the final label after renaming an existing parent', async () => {
    const oldParentLabel = `__task2_old_parent_${runId}__`
    const newParentLabel = `__task2_new_parent_${runId}__`
    const childLabel = `__task2_rename_child_${runId}__`
    const parentId = await insertTag(oldParentLabel)
    const childId = await insertTag(childLabel)

    await applyTopicsImport(
      [
        row(childLabel, { id: childId, parent: newParentLabel }),
        row(newParentLabel, { id: parentId }),
      ],
      false,
      identity,
    )

    const [child] = await AppDataSource.query(
      `SELECT parent_tag_id FROM tags WHERE id = $1`,
      [childId],
    )
    expect(child.parent_tag_id).toBe(parentId)
  })

  it('reports non-topic CSV facets as typed import conflicts', async () => {
    const label = `__task2_program_import_${runId}__`
    const rows = [row(label, { facet: 'program' })]

    const diff = await importTopicsDiff(rows)
    expect(diff.conflicts).toEqual([
      { row: rows[0], reason: 'facet must be topic' },
    ])

    let thrown: unknown
    try {
      await applyTopicsImport(rows, false, identity)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ name: 'TopicsImportConflictError' })
    const [inserted] = await AppDataSource.query(
      `SELECT id FROM tags WHERE value_id = $1`,
      [label],
    )
    expect(inserted).toBeUndefined()
  })

  it('rejects an unchanged child that names a renamed parent by its old label', async () => {
    const oldParentLabel = `__task2_final_parent_old_${runId}__`
    const newParentLabel = `__task2_final_parent_new_${runId}__`
    const childLabel = `__task2_final_child_${runId}__`
    const parentId = await insertTag(oldParentLabel)
    const childId = await insertTag(childLabel, { parentTagId: parentId })

    let thrown: unknown
    try {
      await applyTopicsImport(
        [
          row(newParentLabel, { id: parentId }),
          row(childLabel, { id: childId, parent: oldParentLabel }),
        ],
        false,
        identity,
      )
    } catch (error) {
      thrown = error
    }

    const [parent] = await AppDataSource.query(
      `SELECT value_id FROM tags WHERE id = $1`,
      [parentId],
    )
    const [child] = await AppDataSource.query(
      `SELECT parent_tag_id FROM tags WHERE id = $1`,
      [childId],
    )
    expect(parent.value_id).toBe(oldParentLabel)
    expect(child.parent_tag_id).toBe(parentId)
    expect(thrown).toMatchObject({
      name: 'TopicsImportConflictError',
      message: expect.stringContaining('parent'),
    })
  })

  it('reports unknown CSV IDs as typed conflicts instead of inserting them', async () => {
    const label = `__task2_unknown_id_${runId}__`
    const rows = [row(label, { id: crypto.randomUUID() })]

    const diff = await importTopicsDiff(rows)
    expect(diff.conflicts).toEqual([
      { row: rows[0], reason: 'unknown topic id' },
    ])
    await expect(
      applyTopicsImport(rows, false, identity),
    ).rejects.toMatchObject({ name: 'TopicsImportConflictError' })
    const [inserted] = await AppDataSource.query(
      `SELECT id FROM tags WHERE value_id = $1`,
      [label],
    )
    expect(inserted).toBeUndefined()
  })

  it('reports duplicate CSV IDs as conflicts before applying either row', async () => {
    const originalLabel = `__task2_duplicate_id_original_${runId}__`
    const firstLabel = `__task2_duplicate_id_first_${runId}__`
    const secondLabel = `__task2_duplicate_id_second_${runId}__`
    const tagId = await insertTag(originalLabel)
    const rows = [
      row(firstLabel, { id: tagId }),
      row(secondLabel, { id: tagId }),
    ]

    const diff = await importTopicsDiff(rows)
    expect(diff.conflicts).toEqual([
      { row: rows[0], reason: 'duplicate topic id' },
      { row: rows[1], reason: 'duplicate topic id' },
    ])
    await expect(
      applyTopicsImport(rows, false, identity),
    ).rejects.toMatchObject({ name: 'TopicsImportConflictError' })
    const [tag] = await AppDataSource.query(
      `SELECT value_id FROM tags WHERE id = $1`,
      [tagId],
    )
    expect(tag.value_id).toBe(originalLabel)
  })

  it('rolls back all row changes when the final parent pass detects a cycle', async () => {
    const labelA = `__task2_cycle_a_${runId}__`
    const labelB = `__task2_cycle_b_${runId}__`
    const tagAId = await insertTag(labelA, { description: 'original a' })
    const tagBId = await insertTag(labelB, { description: 'original b' })

    let thrown: unknown
    try {
      await applyTopicsImport(
        [
          row(labelA, {
            id: tagAId,
            description: 'changed a',
            parent: labelB,
          }),
          row(labelB, {
            id: tagBId,
            description: 'changed b',
            parent: labelA,
          }),
        ],
        false,
        identity,
      )
    } catch (error) {
      thrown = error
    }

    const tags: any[] = await AppDataSource.query(
      `SELECT id, description, parent_tag_id FROM tags
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[tagAId, tagBId]],
    )
    expect(tags).toHaveLength(2)
    expect(tags.map((tag) => tag.description).sort()).toEqual([
      'original a',
      'original b',
    ])
    expect(tags.every((tag) => tag.parent_tag_id === null)).toBe(true)
    expect(thrown).toMatchObject({ name: 'TopicsImportConflictError' })
  })

  it('rolls back a successfully inserted queue job when the later import audit fails', async () => {
    const label = `__task2_audit_rollback_${runId}__`
    const tagId = await insertTag(label, { description: 'before audit' })
    const documentId = await insertDocument('audit_rollback')
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, status)
       VALUES ($1, $2, 'llm', 'accepted')`,
      [documentId, tagId],
    )
    const auditFunction = `task2_csv_audit_fail_${suffix}`
    const auditTrigger = `task2_csv_audit_fail_trigger_${suffix}`
    const auditSequence = `task2_csv_audit_seen_queue_${suffix}`
    await AppDataSource.query(`CREATE SEQUENCE ${auditSequence}`)
    await AppDataSource.query(
      `CREATE FUNCTION ${auditFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.action = 'tag_import' AND NEW.actor_user_id = '${actorUserId}'::uuid THEN
           IF NOT EXISTS (
             SELECT 1 FROM reclassify_jobs
             WHERE document_id = '${documentId}'::uuid
           ) THEN
             RAISE EXCEPTION 'task2 audit ran before queue insert';
           END IF;
           PERFORM nextval('${auditSequence}');
           RAISE EXCEPTION 'task2 audit failure';
         END IF;
         RETURN NEW;
       END;
       $$`,
    )
    await AppDataSource.query(
      `CREATE TRIGGER ${auditTrigger} BEFORE INSERT ON audit_log
       FOR EACH ROW EXECUTE FUNCTION ${auditFunction}()`,
    )

    let thrown: unknown
    let auditSawQueuedJob = false
    try {
      await applyTopicsImport(
        [row(label, { id: tagId, description: 'after audit' })],
        true,
        identity,
      )
    } catch (error) {
      thrown = error
    } finally {
      await AppDataSource.query(
        `DROP TRIGGER IF EXISTS ${auditTrigger} ON audit_log`,
      )
      await AppDataSource.query(`DROP FUNCTION IF EXISTS ${auditFunction}()`)
      const [sequence] = await AppDataSource.query(
        `SELECT is_called FROM ${auditSequence}`,
      )
      auditSawQueuedJob = sequence.is_called
      await AppDataSource.query(`DROP SEQUENCE IF EXISTS ${auditSequence}`)
    }

    const [tag] = await AppDataSource.query(
      `SELECT description FROM tags WHERE id = $1`,
      [tagId],
    )
    const [job] = await AppDataSource.query(
      `SELECT id FROM reclassify_jobs WHERE document_id = $1`,
      [documentId],
    )
    const [audit] = await AppDataSource.query(
      `SELECT id FROM audit_log
       WHERE actor_user_id = $1 AND action = 'tag_import'
         AND after->>'reclassify' = 'true'`,
      [actorUserId],
    )
    expect(tag.description).toBe('before audit')
    expect(auditSawQueuedJob).toBe(true)
    expect(job).toBeUndefined()
    expect(audit).toBeUndefined()
    expect(thrown).toMatchObject({ name: 'QueryFailedError' })
  })

  it('rolls back imported rows and audit when set-based enqueue fails', async () => {
    const label = `__task2_enqueue_rollback_${runId}__`
    const tagId = await insertTag(label, { description: 'before enqueue' })
    const documentId = await insertDocument('enqueue_rollback')
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, status)
       VALUES ($1, $2, 'llm', 'accepted')`,
      [documentId, tagId],
    )
    const enqueueFunction = `task2_csv_enqueue_fail_${suffix}`
    const enqueueTrigger = `task2_csv_enqueue_fail_trigger_${suffix}`
    await AppDataSource.query(
      `CREATE FUNCTION ${enqueueFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.document_id = '${documentId}'::uuid THEN
           RAISE EXCEPTION 'task2 enqueue failure';
         END IF;
         RETURN NEW;
       END;
       $$`,
    )
    await AppDataSource.query(
      `CREATE TRIGGER ${enqueueTrigger} BEFORE INSERT ON reclassify_jobs
       FOR EACH ROW EXECUTE FUNCTION ${enqueueFunction}()`,
    )

    let thrown: unknown
    try {
      await applyTopicsImport(
        [row(label, { id: tagId, description: 'after enqueue' })],
        true,
        identity,
      )
    } catch (error) {
      thrown = error
    } finally {
      await AppDataSource.query(
        `DROP TRIGGER IF EXISTS ${enqueueTrigger} ON reclassify_jobs`,
      )
      await AppDataSource.query(`DROP FUNCTION IF EXISTS ${enqueueFunction}()`)
    }

    const [tag] = await AppDataSource.query(
      `SELECT description FROM tags WHERE id = $1`,
      [tagId],
    )
    const [audit] = await AppDataSource.query(
      `SELECT id FROM audit_log
       WHERE actor_user_id = $1 AND action = 'tag_import'
         AND after->>'reclassify' = 'true'`,
      [actorUserId],
    )
    expect(tag.description).toBe('before enqueue')
    expect(audit).toBeUndefined()
    expect(thrown).toMatchObject({ name: 'QueryFailedError' })
  })

  it('quotes carriage returns so export and parse round-trip without data loss', async () => {
    const label = `__task2_cr_export_${runId}__`
    await insertTag(label, { description: 'first\rsecond' })

    const exported = await exportTopicsCsv()
    const parsed = parseTopicsCsv(exported)

    expect(
      parsed.find((parsedRow) => parsedRow.label === label)?.description,
    ).toBe('first\rsecond')
  })
})
