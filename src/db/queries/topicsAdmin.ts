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
  needsReembed: boolean
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
           t.parent_tag_id AS "parentTagId", t.description, t.needs_reembed AS "needsReembed",
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
            t.parent_tag_id AS "parentTagId", t.description, t.needs_reembed AS "needsReembed",
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
    estCost: +(enqueued * EST_PER_DOC_COST).toFixed(4),
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
      estCost: +(r.total * EST_PER_DOC_COST).toFixed(4),
      createdAt: r.createdAt,
    })),
  }
}

// --- Task 6: CSV import (dry-run diff + atomic apply) + export ---

export interface ParsedRow {
  label: string
  description: string
  aliases: string[]
  parent: string
  facet: string
  id: string
}

export interface ImportDiff {
  added: ParsedRow[]
  updated: { row: ParsedRow; current: any }[]
  unchanged: ParsedRow[]
  conflicts: { row: ParsedRow; reason: string }[]
}

/**
 * Minimal CSV parser (no new dep). Handles quoted fields with embedded commas,
 * doubled quotes (""), and embedded newlines within quoted fields.
 * Returns rows mapped to ParsedRow objects with the header:
 * label,description,aliases(pipe-delimited),parent,facet,id
 */
export function parseTopicsCsv(text: string): ParsedRow[] {
  const lines: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false

  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => { lines.push(row); row = [] }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQ = false
      } else {
        field += ch
      }
    } else {
      if (ch === '"') inQ = true
      else if (ch === ',') pushField()
      else if (ch === '\n') { pushField(); pushRow() }
      else if (ch !== '\r') field += ch
    }
  }
  if (field.length > 0 || row.length > 0) { pushField(); pushRow() }

  const [header, ...body] = lines
  if (!header) return []

  const idx: Record<string, number> = {}
  for (let i = 0; i < header.length; i++) idx[header[i].trim()] = i

  const get = (r: string[], k: string) => (idx[k] !== undefined ? r[idx[k]] ?? '' : '')

  return body
    .filter((r) => r.some((c) => c !== ''))
    .map((r) => ({
      label: get(r, 'label').trim(),
      description: get(r, 'description').trim(),
      aliases: get(r, 'aliases').split('|').map((a) => a.trim()).filter(Boolean),
      parent: get(r, 'parent').trim(),
      facet: get(r, 'facet').trim() || 'topic',
      id: get(r, 'id').trim(),
    }))
}

/**
 * Diff parsed CSV rows against the current topic taxonomy in the DB.
 * Matches by id (if present) else by label. Detects: empty labels,
 * duplicate labels in the input, bad parent references (parent label
 * not in DB and not in the input itself).
 */
export async function importTopicsDiff(rows: ParsedRow[]): Promise<ImportDiff> {
  const labels = rows.map((r) => r.label)
  const dup = labels.filter((l, i) => labels.indexOf(l) !== i)
  const inputLabels = new Set(labels.filter(Boolean))

  const existing: any[] = await AppDataSource.query(
    `SELECT t.id, t.value_id, t.description, t.parent_tag_id,
            COALESCE(
              (SELECT string_agg(a.alias, '|' ORDER BY a.alias) FROM tag_aliases a WHERE a.tag_id = t.id),
              ''
            ) AS aliases_str,
            COALESCE((SELECT p.value_id FROM tags p WHERE p.id = t.parent_tag_id), '') AS parent_label
     FROM tags t
     WHERE t.facet = 'topic' AND t.taxonomy_version = 'v1'`,
  )
  const byId = new Map(existing.map((t) => [t.id, t]))
  const byLabel = new Map(existing.map((t) => [t.value_id, t]))

  const added: ParsedRow[] = []
  const updated: { row: ParsedRow; current: any }[] = []
  const unchanged: ParsedRow[] = []
  const conflicts: { row: ParsedRow; reason: string }[] = []

  for (const r of rows) {
    if (!r.label) {
      conflicts.push({ row: r, reason: 'empty label' })
      continue
    }
    if (dup.includes(r.label)) {
      conflicts.push({ row: r, reason: 'duplicate label' })
      continue
    }
    if (r.parent && !byLabel.has(r.parent) && !inputLabels.has(r.parent)) {
      conflicts.push({ row: r, reason: 'bad parent reference' })
      continue
    }

    const cur = r.id ? byId.get(r.id) : byLabel.get(r.label)
    if (!cur) {
      added.push(r)
    } else {
      const descChanged = r.description !== (cur.description ?? '')
      const labelChanged = r.label !== cur.value_id
      const parentChanged = r.parent !== (cur.parent_label ?? '')
      const inputAliasesStr = [...r.aliases].sort().join('|')
      const curAliasesStr = (cur.aliases_str ?? '').split('|').filter(Boolean).sort().join('|')
      const aliasesChanged = inputAliasesStr !== curAliasesStr

      if (descChanged || labelChanged || parentChanged || aliasesChanged) {
        updated.push({ row: r, current: cur })
      } else {
        unchanged.push(r)
      }
    }
  }

  return { added, updated, unchanged, conflicts }
}

/**
 * Apply a CSV import atomically. Calls importTopicsDiff first; if any conflicts,
 * throws without touching the DB. Otherwise wraps all INSERT/UPDATE/alias
 * operations in a single transaction — all changes commit or none.
 * After commit, if reclassify=true, enqueues scoped re-classify per affected tag.
 */
export async function applyTopicsImport(
  rows: ParsedRow[],
  reclassify: boolean,
): Promise<{ applied: number }> {
  const diff = await importTopicsDiff(rows)
  if (diff.conflicts.length > 0) {
    throw new Error(`import has ${diff.conflicts.length} conflict(s) — apply blocked`)
  }

  const affectedTagIds = new Set<string>()

  await AppDataSource.transaction(async (em) => {
    // Build a label→id map for parent resolution (includes existing + newly added)
    const existing: any[] = await em.query(
      `SELECT id, value_id FROM tags WHERE facet = 'topic' AND taxonomy_version = 'v1'`,
    )
    const labelToId = new Map<string, string>(existing.map((t) => [t.value_id, t.id]))

    for (const r of diff.added) {
      const [t] = await em.query(
        `INSERT INTO tags (facet, value_id, taxonomy_version, description, needs_reembed)
         VALUES ($1, $2, 'v1', $3, true) RETURNING id`,
        [r.facet || 'topic', r.label, r.description || null],
      )
      affectedTagIds.add(t.id)
      labelToId.set(r.label, t.id)

      for (const a of r.aliases) {
        await em.query(
          `INSERT INTO tag_aliases (tag_id, alias) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [t.id, a],
        )
      }

      // In-loop parent-set: works when the parent already existed in the DB
      // or was inserted earlier in this same adds loop.
      if (r.parent) {
        const parentId = labelToId.get(r.parent)
        if (parentId) {
          await em.query(`UPDATE tags SET parent_tag_id = $1 WHERE id = $2`, [parentId, t.id])
        }
      }
    }

    // Second pass: set parent_tag_id for added tags whose parent was inserted
    // later in the adds loop (forward reference — child before parent in CSV).
    for (const r of diff.added) {
      if (r.parent) {
        const parentId = labelToId.get(r.parent)
        const childId = labelToId.get(r.label)
        if (parentId && childId) {
          await em.query(`UPDATE tags SET parent_tag_id = $1 WHERE id = $2`, [parentId, childId])
        }
      }
    }

    for (const u of diff.updated) {
      const cur = u.current
      await em.query(
        `UPDATE tags SET value_id = $1, description = $2, needs_reembed = true WHERE id = $3`,
        [u.row.label, u.row.description || null, cur.id],
      )
      affectedTagIds.add(cur.id)
      labelToId.set(u.row.label, cur.id)

      // Replace aliases
      await em.query(`DELETE FROM tag_aliases WHERE tag_id = $1`, [cur.id])
      for (const a of u.row.aliases) {
        await em.query(
          `INSERT INTO tag_aliases (tag_id, alias) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [cur.id, a],
        )
      }

      // Update parent
      if (u.row.parent) {
        const parentId = labelToId.get(u.row.parent)
        if (parentId) {
          await em.query(`UPDATE tags SET parent_tag_id = $1 WHERE id = $2`, [parentId, cur.id])
        }
      } else {
        await em.query(`UPDATE tags SET parent_tag_id = NULL WHERE id = $1`, [cur.id])
      }
    }
  })

  if (reclassify && affectedTagIds.size > 0) {
    for (const tid of affectedTagIds) {
      await enqueueReclassify({ tagId: tid })
    }
  }

  return { applied: diff.added.length + diff.updated.length }
}

/**
 * Export the current topic taxonomy as CSV (richer format, separate from WRI CSV).
 * Columns: label,description,aliases(pipe-delimited),parent,facet,id.
 * CSV-escapes fields containing commas, quotes, or newlines.
 */
export async function exportTopicsCsv(): Promise<string> {
  const rows: any[] = await AppDataSource.query(
    `SELECT t.id, t.value_id AS label, t.description,
            COALESCE((SELECT string_agg(a.alias, '|') FROM tag_aliases a WHERE a.tag_id = t.id), '') AS aliases,
            COALESCE((SELECT p.value_id FROM tags p WHERE p.id = t.parent_tag_id), '') AS parent
     FROM tags t
     WHERE t.facet = 'topic' AND t.taxonomy_version = 'v1'
     ORDER BY t.value_id`,
  )

  const esc = (s: string) => {
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }

  const body = rows.map((r) =>
    [r.label, r.description ?? '', r.aliases ?? '', r.parent ?? '', 'topic', r.id]
      .map(esc)
      .join(','),
  )

  return ['label,description,aliases,parent,facet,id', ...body].join('\n')
}
