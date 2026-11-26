/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { seedTagAliases } from '@/db/queries/tagAliases'

// Gated on DATABASE_URL like the other .db.test.ts suites: schema-only CI has no
// database, so these skip there. Run with `npm run test:db`.
const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

const hasTagAliases = async () => {
  const rows: any[] = await AppDataSource.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name='tag_aliases'`,
  )
  return rows.length > 0
}

d('seedTagAliases (issue #512)', () => {
  const run = Date.now().toString(36)
  const label = `__seed_${run}`
  const otherLabel = `__seed_other_${run}`
  const facet = 'topic'
  const ids: string[] = []

  const cleanup = async () => {
    if (ids.length > 0) {
      await AppDataSource.query(`DELETE FROM tags WHERE id = ANY($1::uuid[])`, [
        ids,
      ])
    }
  }

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    if (!(await hasTagAliases())) return
    for (const value of [label, otherLabel]) {
      const [row] = await AppDataSource.query(
        `INSERT INTO tags (facet, value_id, taxonomy_version, needs_reembed)
         VALUES ($1, $2, 'v1', false) RETURNING id`,
        [facet, value],
      )
      ids.push(row.id)
    }
  })

  afterAll(async () => {
    await cleanup()
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it('flags needs_reembed on every tag that gained an alias', async () => {
    const res = await seedTagAliases([
      { facet, value_id: label, aliases: ['first alias', 'second alias'] },
    ])

    expect(res.inserted).toBe(2)
    expect(res.skipped).toBe(0)
    expect(res.missing).toEqual([])
    expect(res.flagged).toBe(1)

    const [row] = await AppDataSource.query(
      `SELECT needs_reembed FROM tags WHERE id = $1`,
      [ids[0]],
    )
    // The whole point of the fix: without this flag the worker never rebuilds
    // the vector, so `_compose_text`'s "label | aliases" never reaches it.
    expect(row.needs_reembed).toBe(true)
  })

  it('leaves a tag untouched when it gains no alias', async () => {
    const [row] = await AppDataSource.query(
      `SELECT needs_reembed FROM tags WHERE id = $1`,
      [ids[1]],
    )
    expect(row.needs_reembed).toBe(false)
  })

  it('a re-run with nothing new inserts nothing and flags nothing', async () => {
    // Reset the flag so a spurious re-flag is visible rather than masked by the
    // value the previous test left behind.
    await AppDataSource.query(
      `UPDATE tags SET needs_reembed = false WHERE id = $1`,
      [ids[0]],
    )

    const res = await seedTagAliases([
      { facet, value_id: label, aliases: ['first alias', 'second alias'] },
    ])

    expect(res.inserted).toBe(0)
    expect(res.skipped).toBe(2)
    expect(res.flagged).toBe(0)

    const [row] = await AppDataSource.query(
      `SELECT needs_reembed FROM tags WHERE id = $1`,
      [ids[0]],
    )
    // A no-op seed must not trigger a taxonomy-wide re-embed.
    expect(row.needs_reembed).toBe(false)
  })

  it('reports entries that match no tag instead of silently skipping', async () => {
    const res = await seedTagAliases([
      { facet, value_id: `__no_such_tag_${run}`, aliases: ['x'] },
    ])
    expect(res.missing).toEqual([`${facet}:__no_such_tag_${run}`])
    expect(res.inserted).toBe(0)
    expect(res.flagged).toBe(0)
  })

  it('matches the tag label case-insensitively', async () => {
    const res = await seedTagAliases([
      { facet, value_id: label.toUpperCase(), aliases: ['case alias'] },
    ])
    expect(res.inserted).toBe(1)
    expect(res.flagged).toBe(1)
  })
})
