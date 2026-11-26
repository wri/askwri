import { AppDataSource } from '../data-source'

/**
 * Alias seeding for scripts/seed-tag-aliases.ts.
 *
 * Deliberately free of `@/...` path aliases so the seeder stays runnable the way
 * the other scripts are — `ts-node --project tsconfig.typeorm.json` has no
 * tsconfig-paths registration, and importing topicsAdmin.ts here pulls in
 * `@/config/models` and dies with "Cannot find module".
 */
export interface AliasSeedEntry {
  facet: string
  value_id: string
  aliases: string[]
}

export interface AliasSeedResult {
  inserted: number
  skipped: number
  missing: string[]
  flagged: number
}

/**
 * Insert seed aliases and flag their tags for re-embed, atomically.
 *
 * `needs_reembed` is the handoff between the two owners of this data: CLAUDE.md
 * gives `tags`/`tag_aliases` to the app tier and `tag_embeddings` to the Python
 * side, and the worker's embed sweep (worker/stages/embed_tags.py) rebuilds a
 * vector only when that flag is set. A writer that inserts aliases without
 * setting it leaves the tag embedded from its label alone — `_compose_text`
 * builds "label | aliases — description", so the aliases are simply absent from
 * the vector until something else happens to flag the tag.
 *
 * That is not hypothetical. The aliases seeded on 2026-08-20 were never
 * embedded; the vectors stayed label-only until 2026-11-26, three months, when
 * an unrelated CSV import flagged 17 of the same tags. See issue #512.
 *
 * Only tags that actually gained an alias are flagged: a re-run of an unchanged
 * seed is a no-op, not a taxonomy-wide re-embed.
 */
export async function seedTagAliases(
  entries: AliasSeedEntry[],
): Promise<AliasSeedResult> {
  return AppDataSource.transaction(async (em) => {
    let inserted = 0
    let skipped = 0
    const missing: string[] = []
    const gained = new Set<string>()

    for (const e of entries) {
      // Case-insensitive on purpose: the seed file is hand-maintained and its
      // capitalisation has drifted from tags.value_id before.
      const rows: any[] = await em.query(
        `SELECT id FROM tags WHERE facet = $1 AND lower(value_id) = lower($2)`,
        [e.facet, e.value_id],
      )
      if (rows.length === 0) {
        missing.push(`${e.facet}:${e.value_id}`)
        continue
      }
      for (const alias of e.aliases) {
        const res: any[] = await em.query(
          `INSERT INTO tag_aliases (tag_id, alias) VALUES ($1, $2)
           ON CONFLICT (tag_id, alias) DO NOTHING RETURNING tag_id`,
          [rows[0].id, alias],
        )
        if (res.length > 0) {
          inserted += 1
          gained.add(rows[0].id)
        } else {
          skipped += 1
        }
      }
    }

    const ids = [...gained]
    if (ids.length > 0) {
      await em.query(
        `UPDATE tags SET needs_reembed = true WHERE id = ANY($1::uuid[])`,
        [ids],
      )
    }

    return { inserted, skipped, missing, flagged: ids.length }
  })
}
