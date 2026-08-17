/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { listTopicsWithCounts, getTopic } from '@/db/queries/topicsAdmin'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

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
})
