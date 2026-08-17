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

// --- Task 4: delete (children warning) + merge ---

export type DeleteTopicResult =
  | { deleted: true }
  | { deleted: false; reason: 'in_use' | 'has_children' | 'not_found'; error: string }

/**
 * Delete a topic tag if it has no documents and no children.
 * Checks children (parent_tag_id refs) first → has_children.
 * Then atomic DELETE with NOT EXISTS(document_tags) guard → in_use or deleted.
 * Topic-scoped: the tag must be facet='topic'.
 */
export async function deleteTopicIfUnused(
  id: string,
  identity: AdminIdentity,
): Promise<DeleteTopicResult> {
  const [tag] = await AppDataSource.query(
    `SELECT id FROM tags WHERE id = $1 AND facet = 'topic'`,
    [id],
  )
  if (!tag) return { deleted: false, reason: 'not_found', error: 'not found' }

  const [children] = await AppDataSource.query(
    `SELECT count(*)::int AS c FROM tags WHERE parent_tag_id = $1`,
    [id],
  )
  if (children.c > 0) return { deleted: false, reason: 'has_children', error: 're-parent or delete children first' }

  return AppDataSource.transaction(async (em) => {
    const [rows] = await em.query(
      `DELETE FROM tags WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM document_tags WHERE tag_id = $1)
       RETURNING id`,
      [id],
    )
    if (!Array.isArray(rows) || rows.length === 0)
      return { deleted: false, reason: 'in_use' as const, error: 'topic is applied to documents' }

    await writeAudit({
      ...auditActor(identity),
      action: 'tag_delete',
      entityType: 'tag',
      entityId: id,
    })
    return { deleted: true as const }
  })
}

/**
 * Merge one topic tag into another. Moves document_tags from source to target,
 * drops conflicting rows (doc already on target), re-parents source's children
 * to target, deletes source's aliases, deletes source tag. All in one transaction.
 * Rejects self-merge and missing tags. Writes audit_log (tag_merge).
 */
export async function mergeTags(
  intoId: string,
  fromId: string,
  identity: AdminIdentity,
): Promise<{ ok: true; moved: number } | { error: string }> {
  if (intoId === fromId) return { error: 'cannot merge a tag into itself' }

  return AppDataSource.transaction(async (em) => {
    const [into] = await em.query(
      `SELECT id FROM tags WHERE id = $1 AND facet = 'topic'`,
      [intoId],
    )
    const [from] = await em.query(`SELECT id FROM tags WHERE id = $1`, [fromId])
    if (!into || !from) return { error: 'tag not found' }

    // Move document_tags: UPDATE rows where the doc doesn't already have the target tag
    // Use a CTE to count moved rows in one statement (avoids RETURNING array ambiguity)
    const [movedRow] = await em.query(
      `WITH moved AS (
         UPDATE document_tags SET tag_id = $1
         WHERE tag_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM document_tags dt
           WHERE dt.document_id = document_tags.document_id AND dt.tag_id = $1
         )
         RETURNING document_id
       )
       SELECT count(*)::int AS moved FROM moved`,
      [intoId, fromId],
    )
    const moved = movedRow?.moved ?? 0

    // Drop remaining source rows (conflicts — doc already on target)
    await em.query(`DELETE FROM document_tags WHERE tag_id = $1`, [fromId])

    // Re-parent source's children to target (exclude target itself to prevent
    // a self-referencing cycle when `into` is itself a child of `from`)
    await em.query(
      `UPDATE tags SET parent_tag_id = $1 WHERE parent_tag_id = $2 AND id <> $1`,
      [intoId, fromId],
    )

    // Delete source's aliases (explicit; FK CASCADE would handle it too)
    await em.query(`DELETE FROM tag_aliases WHERE tag_id = $1`, [fromId])

    // Delete the source tag
    await em.query(`DELETE FROM tags WHERE id = $1`, [fromId])

    await writeAudit({
      ...auditActor(identity),
      action: 'tag_merge',
      entityType: 'tag',
      entityId: intoId,
      before: { mergedFrom: fromId },
      after: { movedDocs: moved },
    })

    return { ok: true as const, moved }
  })
}

// --- Task 5: reclassify enqueue + status + cost estimate ---

export const EST_PER_DOC_COST = 0.0008 // gpt-5-mini per-doc classify (spec §5.5)

/**
 * Enqueue reclassify jobs for a full-corpus or scoped re-classify run.
 * 'all' scope: documents with status='ready'.
 * {tagId} scope: documents with document_tags where tag_id=tagId AND source='llm'.
 * One shared run_id (crypto.randomUUID()) per enqueue so the status panel
 * can group jobs into a run. Idempotent via the partial unique index
 * reclassify_jobs_one_open_per_doc (ON CONFLICT DO NOTHING).
 */
export async function enqueueReclassify(
  scope: 'all' | { tagId: string },
): Promise<{ enqueued: number; estCost: number; runId: string }> {
  let docIds: string[]
  if (scope === 'all') {
    docIds = (
      await AppDataSource.query(`SELECT id FROM documents WHERE status = 'ready'`)
    ).map((r: any) => r.id)
  } else {
    docIds = (
      await AppDataSource.query(
        `SELECT dt.document_id FROM document_tags dt WHERE dt.tag_id = $1 AND dt.source = 'llm'`,
        [scope.tagId],
      )
    ).map((r: any) => r.document_id)
  }

  if (docIds.length === 0) {
    return { enqueued: 0, estCost: 0, runId: crypto.randomUUID() }
  }

  const runId = crypto.randomUUID()
  const scopeTagId = scope === 'all' ? null : scope.tagId
  let enqueued = 0

  for (const docId of docIds) {
    const [row] = await AppDataSource.query(
      `INSERT INTO reclassify_jobs (document_id, scope_tag_id, run_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (document_id) WHERE status IN ('queued', 'running') DO NOTHING
       RETURNING id`,
      [docId, scopeTagId, runId],
    )
    if (row) enqueued++
  }

  return {
    enqueued,
    estCost: +(enqueued * EST_PER_DOC_COST).toFixed(2),
    runId,
  }
}

export interface ReclassifyStatus {
  queued: number
  running: number
  done: number
  error: number
  recent: {
    runId: string
    scope: 'all' | string
    total: number
    done: number
    error: number
    estCost: number
    createdAt: string
  }[]
}

/**
 * Get aggregate status of reclassify jobs: counts by status + recent runs
 * grouped by run_id (up to 20). Each recent entry has total/done/error
 * counts and estCost = total * EST_PER_DOC_COST.
 */
export async function reclassifyStatus(): Promise<ReclassifyStatus> {
  const counts: any[] = await AppDataSource.query(
    `SELECT status, count(*)::int AS c FROM reclassify_jobs GROUP BY status`,
  )
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.c]))

  const recent: any[] = await AppDataSource.query(
    `SELECT run_id AS "runId",
            scope_tag_id AS "scopeTagId",
            count(*)::int AS total,
            count(*) FILTER (WHERE status = 'done')::int AS done,
            count(*) FILTER (WHERE status = 'error')::int AS error,
            min(created_at) AS "createdAt"
     FROM reclassify_jobs
     GROUP BY run_id, scope_tag_id
     ORDER BY min(created_at) DESC
     LIMIT 20`,
  )

  return {
    queued: byStatus.queued ?? 0,
    running: byStatus.running ?? 0,
    done: byStatus.done ?? 0,
    error: byStatus.error ?? 0,
    recent: recent.map((r) => ({
      runId: r.runId,
      scope: r.scopeTagId ?? 'all',
      total: r.total,
      done: r.done,
      error: r.error,
      estCost: +(r.total * EST_PER_DOC_COST).toFixed(2),
      createdAt: r.createdAt,
    })),
  }
}
