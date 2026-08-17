import { AppDataSource } from '../data-source'
import { writeAudit } from './audit'
import type { AdminIdentity } from '../../lib/auth/identity'
import { auditActor } from '../../lib/auth/identity'

export interface TopicRow {
  id: string
  facet: string
  valueId: string
  taxonomyVersion: string
  parentTagId: string | null
  description: string | null
  aliases: string[]
  acceptedCount: number
  suggestedCount: number
}

export type TopicDetail = TopicRow

/**
 * List all topic-facet tags with document counts and aliases.
 * Topic-scoped: filters facet='topic' AND taxonomy_version='v1'.
 * Aliases via a correlated subquery with COALESCE to return [] not null.
 */
export async function listTopicsWithCounts(): Promise<TopicRow[]> {
  return AppDataSource.query(`
    SELECT t.id, t.facet, t.value_id AS "valueId", t.taxonomy_version AS "taxonomyVersion",
           t.parent_tag_id AS "parentTagId", t.description,
           COALESCE(
             (SELECT array_agg(a.alias) FROM tag_aliases a WHERE a.tag_id = t.id),
             '{}'::text[]
           ) AS aliases,
           count(*) FILTER (WHERE dt.status = 'accepted')::int  AS "acceptedCount",
           count(*) FILTER (WHERE dt.status = 'suggested')::int AS "suggestedCount"
    FROM tags t
    LEFT JOIN document_tags dt ON dt.tag_id = t.id
    WHERE t.facet = 'topic' AND t.taxonomy_version = 'v1'
    GROUP BY t.id
    ORDER BY t.value_id
  `)
}

/**
 * Get a single topic tag by id, with aliases and document counts.
 * Returns null if the tag doesn't exist.
 */
export async function getTopic(id: string): Promise<TopicDetail | null> {
  const [row] = await AppDataSource.query(
    `SELECT t.id, t.facet, t.value_id AS "valueId", t.taxonomy_version AS "taxonomyVersion",
            t.parent_tag_id AS "parentTagId", t.description,
            COALESCE(
              (SELECT array_agg(a.alias) FROM tag_aliases a WHERE a.tag_id = t.id),
              '{}'::text[]
            ) AS aliases,
            count(*) FILTER (WHERE dt.status = 'accepted')::int  AS "acceptedCount",
            count(*) FILTER (WHERE dt.status = 'suggested')::int AS "suggestedCount"
     FROM tags t
     LEFT JOIN document_tags dt ON dt.tag_id = t.id
     WHERE t.id = $1 AND t.facet = 'topic' AND t.taxonomy_version = 'v1'
     GROUP BY t.id`,
    [id],
  )
  return row ?? null
}

// --- Task 3: create + edit (cycle prevention) + needs_reembed ---

export interface CreateTopicInput {
  valueId: string
  description?: string | null
  aliases?: string[]
  parentTagId?: string | null
}

/**
 * Create a new topic tag. Sets needs_reembed=true (new tag needs an embedding).
 * Writes aliases and an audit_log row. Topic-scoped: always facet='topic',
 * taxonomy_version='v1'.
 */
export async function createTopic(
  input: CreateTopicInput,
  identity: AdminIdentity,
): Promise<{ id: string; valueId: string } | { error: string }> {
  const valueId = input.valueId.trim()
  if (!valueId) return { error: 'valueId must be non-empty' }
  const aliases = (input.aliases ?? []).map((a) => a.trim()).filter(Boolean)

  return AppDataSource.transaction(async (em) => {
    // Dup-check: topic-scoped
    const existing = await em.query(
      `SELECT 1 FROM tags WHERE facet = 'topic' AND value_id = $1 AND taxonomy_version = 'v1'`,
      [valueId],
    )
    if (existing.length > 0) return { error: 'topic already exists' }

    const [tag] = await em.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version, description, parent_tag_id, needs_reembed)
       VALUES ('topic', $1, 'v1', $2, $3, true)
       RETURNING id, value_id`,
      [valueId, input.description ?? null, input.parentTagId ?? null],
    )

    for (const alias of aliases) {
      await em.query(
        `INSERT INTO tag_aliases (tag_id, alias) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [tag.id, alias],
      )
    }

    await writeAudit({
      ...auditActor(identity),
      action: 'tag_create',
      entityType: 'tag',
      entityId: tag.id,
      after: { valueId, description: input.description, aliases, parentTagId: input.parentTagId ?? null },
    })

    return tag
  })
}

export interface UpdateTopicPatch {
  valueId?: string
  description?: string | null
  aliases?: string[]
  parentTagId?: string | null
}

/**
 * Edit a topic tag's label, description, aliases, and/or parent.
 * Cycle prevention: if setting a parent, an ancestor-walk CTE checks that
 * the new parent is not a descendant of this tag. Returns { error: 'cycle' }
 * without updating if a cycle would be created.
 * Sets needs_reembed=true when valueId, description, or aliases change
 * (not on parent-only change — parent doesn't affect the embedding text).
 */
export async function updateTopic(
  id: string,
  patch: UpdateTopicPatch,
  identity: AdminIdentity,
): Promise<{ id: string; valueId: string; description: string | null; parentTagId: string | null } | null | { error: string }> {
  const reembedNeeded =
    patch.valueId !== undefined ||
    patch.description !== undefined ||
    patch.aliases !== undefined

  return AppDataSource.transaction(async (em) => {
    const [tag] = await em.query(
      `SELECT id, value_id, description, parent_tag_id FROM tags WHERE id = $1 AND facet = 'topic' AND taxonomy_version = 'v1'`,
      [id],
    )
    if (!tag) return null

    // Cycle check: if setting a parent, that parent must not be a descendant of this tag.
    if (patch.parentTagId !== undefined && patch.parentTagId !== null) {
      const [cycle] = await em.query(
        `WITH RECURSIVE ancestors AS (
           SELECT id, parent_tag_id FROM tags WHERE id = $1
           UNION ALL
           SELECT t.id, t.parent_tag_id FROM tags t
           JOIN ancestors a ON t.id = a.parent_tag_id
         )
         SELECT 1 FROM ancestors WHERE id = $2`,
        [patch.parentTagId, id],
      )
      if (cycle) return { error: 'cycle' }
    }

    // Build dynamic SET clause with parameterized placeholders
    const sets: string[] = []
    const args: any[] = []
    const push = (col: string, val: any) => {
      args.push(val)
      sets.push(`${col} = $${args.length}`)
    }
    if (patch.valueId !== undefined) {
      const trimmed = patch.valueId.trim()
      if (!trimmed) return { error: 'valueId must be non-empty' }
      push('value_id', trimmed)
    }
    if (patch.description !== undefined) push('description', patch.description)
    if (patch.parentTagId !== undefined) push('parent_tag_id', patch.parentTagId)
    if (reembedNeeded) push('needs_reembed', true)

    if (sets.length > 0) {
      args.push(id)
      await em.query(
        `UPDATE tags SET ${sets.join(', ')} WHERE id = $${args.length}`,
        args,
      )
    }

    // Replace aliases if provided
    if (patch.aliases !== undefined) {
      await em.query(`DELETE FROM tag_aliases WHERE tag_id = $1`, [id])
      for (const alias of patch.aliases.map((a) => a.trim()).filter(Boolean)) {
        await em.query(
          `INSERT INTO tag_aliases (tag_id, alias) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, alias],
        )
      }
    }

    // Fetch after-state for audit
    const [after] = await em.query(
      `SELECT id, value_id, description, parent_tag_id FROM tags WHERE id = $1`,
      [id],
    )

    await writeAudit({
      ...auditActor(identity),
      action: 'tag_update',
      entityType: 'tag',
      entityId: id,
      before: { valueId: tag.value_id, description: tag.description, parentTagId: tag.parent_tag_id },
      after: { valueId: after.value_id, description: after.description, parentTagId: after.parent_tag_id, aliases: patch.aliases },
    })

    return {
      id: after.id,
      valueId: after.value_id,
      description: after.description,
      parentTagId: after.parent_tag_id,
    }
  })
}
