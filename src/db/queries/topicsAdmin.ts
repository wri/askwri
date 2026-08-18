import { AppDataSource } from '../data-source'
import { writeAudit } from './audit'
import type { AdminIdentity } from '../../lib/auth/identity'
import { auditActor } from '../../lib/auth/identity'
import type { EntityManager } from 'typeorm'

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

async function findV1Topic(
  em: EntityManager,
  id: string,
): Promise<{ id: string } | null> {
  const [topic] = await em.query(
    `SELECT id FROM tags WHERE id = $1 AND facet = 'topic' AND taxonomy_version = 'v1'`,
    [id],
  )
  return topic ?? null
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

    if (input.parentTagId !== undefined && input.parentTagId !== null) {
      const parent = await findV1Topic(em, input.parentTagId)
      if (!parent) return { error: 'parent must be a v1 topic' }
    }

    const [tag] = await em.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version, description, parent_tag_id, needs_reembed)
       VALUES ('topic', $1, 'v1', $2, $3, true)
       RETURNING id, value_id AS "valueId"`,
      [valueId, input.description ?? null, input.parentTagId ?? null],
    )

    for (const alias of aliases) {
      await em.query(
        `INSERT INTO tag_aliases (tag_id, alias) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [tag.id, alias],
      )
    }

    await writeAudit(
      {
        ...auditActor(identity),
        action: 'tag_create',
        entityType: 'tag',
        entityId: tag.id,
        after: {
          valueId,
          description: input.description,
          aliases,
          parentTagId: input.parentTagId ?? null,
        },
      },
      em,
    )

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
): Promise<
  | {
      id: string
      valueId: string
      description: string | null
      parentTagId: string | null
    }
  | null
  | { error: string }
> {
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
      const parent = await findV1Topic(em, patch.parentTagId)
      if (!parent) return { error: 'parent must be a v1 topic' }
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
    if (patch.parentTagId !== undefined)
      push('parent_tag_id', patch.parentTagId)
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

    await writeAudit(
      {
        ...auditActor(identity),
        action: 'tag_update',
        entityType: 'tag',
        entityId: id,
        before: {
          valueId: tag.value_id,
          description: tag.description,
          parentTagId: tag.parent_tag_id,
        },
        after: {
          valueId: after.value_id,
          description: after.description,
          parentTagId: after.parent_tag_id,
          aliases: patch.aliases,
        },
      },
      em,
    )

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
  | {
      deleted: false
      reason: 'in_use' | 'has_children' | 'not_found'
      error: string
    }

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
  if (children.c > 0)
    return {
      deleted: false,
      reason: 'has_children',
      error: 're-parent or delete children first',
    }

  return AppDataSource.transaction(async (em) => {
    const [rows] = await em.query(
      `DELETE FROM tags WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM document_tags WHERE tag_id = $1)
       RETURNING id`,
      [id],
    )
    if (!Array.isArray(rows) || rows.length === 0)
      return {
        deleted: false,
        reason: 'in_use' as const,
        error: 'topic is applied to documents',
      }

    await writeAudit(
      {
        ...auditActor(identity),
        action: 'tag_delete',
        entityType: 'tag',
        entityId: id,
      },
      em,
    )
    return { deleted: true as const }
  })
}

async function enqueueReclassifyDocumentIds(
  em: EntityManager,
  documentIds: string[],
  scopeTagId: string | null,
): Promise<{ enqueued: number; runId: string }> {
  const runId = crypto.randomUUID()
  if (documentIds.length === 0) return { enqueued: 0, runId }

  const [result] = await em.query(
    `WITH candidates AS (
       SELECT DISTINCT document_id
       FROM unnest($1::uuid[]) AS candidate(document_id)
     ), inserted AS (
       INSERT INTO reclassify_jobs (document_id, scope_tag_id, run_id)
       SELECT document_id, $2, $3 FROM candidates
       ON CONFLICT (document_id) WHERE status IN ('queued', 'running')
       DO NOTHING
       RETURNING id
     )
     SELECT count(*)::int AS enqueued FROM inserted`,
    [documentIds, scopeTagId, runId],
  )

  return { enqueued: result?.enqueued ?? 0, runId }
}

/**
 * Merge one v1 topic into another. Assignment consolidation preserves protected
 * human/external precedence, aliases and children move to the survivor, and
 * affected documents are queued in the same transaction as the merge audit.
 */
export async function mergeTags(
  intoId: string,
  fromId: string,
  identity: AdminIdentity,
): Promise<{ ok: true; moved: number; enqueued: number } | { error: string }> {
  if (intoId === fromId) return { error: 'cannot merge a tag into itself' }

  return AppDataSource.transaction(async (em) => {
    const locked: any[] = await em.query(
      `SELECT id, facet, taxonomy_version
       FROM tags
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [[intoId, fromId]],
    )
    const byId = new Map(locked.map((tag) => [tag.id, tag]))
    const into = byId.get(intoId)
    const from = byId.get(fromId)
    if (
      !into ||
      !from ||
      into.facet !== 'topic' ||
      from.facet !== 'topic' ||
      into.taxonomy_version !== 'v1' ||
      from.taxonomy_version !== 'v1'
    ) {
      return { error: 'tag not found' }
    }

    const [descendant] = await em.query(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent_tag_id FROM tags WHERE id = $1
         UNION ALL
         SELECT t.id, t.parent_tag_id FROM tags t
         JOIN ancestors a ON t.id = a.parent_tag_id
       )
       SELECT 1 FROM ancestors WHERE id = $2`,
      [intoId, fromId],
    )
    if (descendant) {
      return { error: 'cannot merge a topic into its descendant' }
    }

    const [outOfScopeChild] = await em.query(
      `SELECT id FROM tags
       WHERE parent_tag_id = $1
         AND (facet <> 'topic' OR taxonomy_version <> 'v1')
       LIMIT 1
       FOR UPDATE`,
      [fromId],
    )
    if (outOfScopeChild) {
      return { error: 'cannot merge a topic with out-of-scope children' }
    }

    const affectedDocuments: any[] = await em.query(
      `SELECT document_id FROM document_tags WHERE tag_id = $1`,
      [fromId],
    )
    const affectedDocumentIds = affectedDocuments.map(
      (row) => row.document_id as string,
    )

    const [movedRow] = await em.query(
      `WITH moved AS (
         INSERT INTO document_tags
           (document_id, tag_id, source, confidence, model_version, status, created_at)
         SELECT document_id, $1, source, confidence, model_version, status, created_at
         FROM document_tags
         WHERE tag_id = $2
         ON CONFLICT (document_id, tag_id) DO UPDATE
         SET source = EXCLUDED.source,
             confidence = EXCLUDED.confidence,
             model_version = EXCLUDED.model_version,
             status = EXCLUDED.status,
             created_at = EXCLUDED.created_at
         WHERE EXCLUDED.source IN ('human', 'external')
           AND document_tags.source = 'llm'
         RETURNING document_id
       )
       SELECT count(*)::int AS moved FROM moved`,
      [intoId, fromId],
    )
    const moved = movedRow?.moved ?? 0

    await em.query(`DELETE FROM document_tags WHERE tag_id = $1`, [fromId])

    await em.query(
      `UPDATE tags SET parent_tag_id = $1
       WHERE parent_tag_id = $2
         AND facet = 'topic'
         AND taxonomy_version = 'v1'`,
      [intoId, fromId],
    )

    await em.query(
      `INSERT INTO tag_aliases (tag_id, alias)
       SELECT $1, alias FROM tag_aliases WHERE tag_id = $2
       ON CONFLICT DO NOTHING`,
      [intoId, fromId],
    )
    await em.query(
      `UPDATE tags SET needs_reembed = true
       WHERE id = $1
         AND EXISTS (SELECT 1 FROM tag_aliases WHERE tag_id = $2)`,
      [intoId, fromId],
    )

    const { enqueued } = await enqueueReclassifyDocumentIds(
      em,
      affectedDocumentIds,
      intoId,
    )

    await em.query(`DELETE FROM tags WHERE id = $1`, [fromId])

    await writeAudit(
      {
        ...auditActor(identity),
        action: 'tag_merge',
        entityType: 'tag',
        entityId: intoId,
        before: { mergedFrom: fromId },
        after: { movedDocs: moved, enqueued },
      },
      em,
    )

    return { ok: true as const, moved, enqueued }
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
  identity?: AdminIdentity,
): Promise<{ enqueued: number; estCost: number; runId: string }> {
  let docIds: string[]
  if (scope === 'all') {
    docIds = (
      await AppDataSource.query(
        `SELECT id FROM documents WHERE status = 'ready'`,
      )
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

  if (identity) {
    await writeAudit({
      ...auditActor(identity),
      action: 'reclassify_enqueue',
      entityType: 'tag',
      entityId: scope === 'all' ? null : scope.tagId,
      after: { enqueued, scope: scope === 'all' ? 'all' : scope.tagId },
    })
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

/**
 * Mark all topic tags lacking a tag_embeddings row for re-embedding. The worker's
 * embed sweep (embed_tags.sweep_pending / build_all_embeddings) picks these up —
 * the app never calls Bedrock. Returns the number of tags queued. Audited because
 * it mutates tags.needs_reembed for potentially the whole topic tree.
 */
export async function rebuildTagEmbeddings(
  identity?: AdminIdentity,
): Promise<{ queued: number }> {
  const rows: any[] = await AppDataSource.query(
    `UPDATE tags
     SET needs_reembed = true
     WHERE facet = 'topic'
       AND taxonomy_version = 'v1'
       AND NOT EXISTS (
         SELECT 1 FROM tag_embeddings te WHERE te.tag_id = tags.id
       )
     RETURNING id`,
  )
  if (identity) {
    await writeAudit({
      ...auditActor(identity),
      action: 'tag_embeddings_rebuild',
      entityType: 'tag',
      entityId: null,
      after: { queued: rows.length },
    })
  }
  return { queued: rows.length }
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

export class TopicsImportConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TopicsImportConflictError'
  }
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

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    lines.push(row)
    row = []
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else {
        field += ch
      }
    } else {
      if (ch === '"') inQ = true
      else if (ch === ',') pushField()
      else if (ch === '\n') {
        pushField()
        pushRow()
      } else if (ch !== '\r') field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    pushField()
    pushRow()
  }

  const [header, ...body] = lines
  if (!header) return []

  const idx: Record<string, number> = {}
  for (let i = 0; i < header.length; i++) idx[header[i].trim()] = i

  const get = (r: string[], k: string) =>
    idx[k] !== undefined ? (r[idx[k]] ?? '') : ''

  return body
    .filter((r) => r.some((c) => c !== ''))
    .map((r) => ({
      label: get(r, 'label').trim(),
      description: get(r, 'description').trim(),
      aliases: get(r, 'aliases')
        .split('|')
        .map((a) => a.trim())
        .filter(Boolean),
      parent: get(r, 'parent').trim(),
      facet: get(r, 'facet').trim() || 'topic',
      id: get(r, 'id').trim(),
    }))
}

/**
 * Diff parsed CSV rows against the current topic taxonomy in the DB.
 * Matches by id (if present) else by label. Detects: empty labels,
 * non-topic facets, duplicate labels in the input, and bad parent references
 * (parent label not in DB and not in the input itself).
 */
async function buildTopicsImportDiff(
  rows: ParsedRow[],
  em: EntityManager,
): Promise<ImportDiff> {
  const seenLabels = new Set<string>()
  const duplicateLabels = new Set<string>()
  const seenIds = new Set<string>()
  const duplicateIds = new Set<string>()
  for (const { label } of rows) {
    if (seenLabels.has(label)) duplicateLabels.add(label)
    seenLabels.add(label)
  }
  for (const { id } of rows) {
    if (!id) continue
    if (seenIds.has(id)) duplicateIds.add(id)
    seenIds.add(id)
  }
  const inputLabels = new Set([...seenLabels].filter(Boolean))

  const existing: any[] = await em.query(
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
    if (r.facet !== 'topic') {
      conflicts.push({ row: r, reason: 'facet must be topic' })
      continue
    }
    if (duplicateLabels.has(r.label)) {
      conflicts.push({ row: r, reason: 'duplicate label' })
      continue
    }
    if (r.id && duplicateIds.has(r.id)) {
      conflicts.push({ row: r, reason: 'duplicate topic id' })
      continue
    }
    if (r.parent && !byLabel.has(r.parent) && !inputLabels.has(r.parent)) {
      conflicts.push({ row: r, reason: 'bad parent reference' })
      continue
    }

    const idMatch = r.id ? byId.get(r.id) : undefined
    if (r.id && !idMatch) {
      conflicts.push({ row: r, reason: 'unknown topic id' })
      continue
    }
    const labelOwner = byLabel.get(r.label)
    if (r.id && labelOwner && labelOwner.id !== r.id) {
      conflicts.push({ row: r, reason: 'label belongs to another topic' })
      continue
    }

    const cur = idMatch ?? labelOwner
    if (!cur) {
      added.push(r)
    } else {
      const descChanged = r.description !== (cur.description ?? '')
      const labelChanged = r.label !== cur.value_id
      const parentChanged = r.parent !== (cur.parent_label ?? '')
      const inputAliasesStr = [...r.aliases].sort().join('|')
      const curAliasesStr = (cur.aliases_str ?? '')
        .split('|')
        .filter(Boolean)
        .sort()
        .join('|')
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

export async function importTopicsDiff(rows: ParsedRow[]): Promise<ImportDiff> {
  return buildTopicsImportDiff(rows, AppDataSource.manager)
}

/**
 * Cycle guard for parent-set during CSV import. Setting childTagId.parent =
 * parentTagId would create a cycle if childTagId is already an ancestor of
 * parentTagId (i.e. parentTagId is a descendant of childTagId). Mirrors the
 * ancestor-walk CTE used by updateTopic. Throws on cycle — the import route
 * maps the throw to 409, and the surrounding transaction rolls back.
 */
async function assertNoParentCycle(
  em: EntityManager,
  parentId: string,
  childId: string,
): Promise<void> {
  const [cycle] = await em.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_tag_id FROM tags WHERE id = $1
       UNION ALL
       SELECT t.id, t.parent_tag_id FROM tags t
       JOIN ancestors a ON t.id = a.parent_tag_id
     )
     SELECT 1 FROM ancestors WHERE id = $2`,
    [parentId, childId],
  )
  if (cycle) {
    throw new TopicsImportConflictError(
      'import would create a cycle in the topic tree',
    )
  }
}

/**
 * Apply a CSV import atomically. Labels, descriptions, and aliases change first;
 * parent relationships resolve from the final label map in a separate pass.
 * Optional deduplicated queue rows and the audit are written in the same
 * transaction, so every import side effect commits or rolls back together.
 */
export async function applyTopicsImport(
  rows: ParsedRow[],
  reclassify: boolean,
  identity?: AdminIdentity,
): Promise<{ applied: number }> {
  return AppDataSource.transaction(async (em) => {
    const diff = await buildTopicsImportDiff(rows, em)
    if (diff.conflicts.length > 0) {
      throw new TopicsImportConflictError(
        `import has ${diff.conflicts.length} conflict(s) — apply blocked`,
      )
    }

    const affectedTagIds = new Set<string>()
    const rowTagIds = new Map<ParsedRow, string>()

    for (const r of diff.added) {
      const [t] = await em.query(
        `INSERT INTO tags (facet, value_id, taxonomy_version, description, needs_reembed)
         VALUES ('topic', $1, 'v1', $2, true) RETURNING id`,
        [r.label, r.description || null],
      )
      affectedTagIds.add(t.id)
      rowTagIds.set(r, t.id)

      for (const a of r.aliases) {
        await em.query(
          `INSERT INTO tag_aliases (tag_id, alias) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [t.id, a],
        )
      }
    }

    for (const u of diff.updated) {
      const cur = u.current
      await em.query(
        `UPDATE tags SET value_id = $1, description = $2, needs_reembed = true WHERE id = $3`,
        [u.row.label, u.row.description || null, cur.id],
      )
      affectedTagIds.add(cur.id)
      rowTagIds.set(u.row, cur.id)

      await em.query(`DELETE FROM tag_aliases WHERE tag_id = $1`, [cur.id])
      for (const a of u.row.aliases) {
        await em.query(
          `INSERT INTO tag_aliases (tag_id, alias) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [cur.id, a],
        )
      }
    }

    const finalTopics: any[] = await em.query(
      `SELECT id, value_id FROM tags
       WHERE facet = 'topic' AND taxonomy_version = 'v1'`,
    )
    const finalLabelToId = new Map<string, string>(
      finalTopics.map((topic) => [topic.value_id, topic.id]),
    )

    for (const unchangedRow of diff.unchanged) {
      const unchangedId =
        unchangedRow.id || finalLabelToId.get(unchangedRow.label)
      if (!unchangedId) {
        throw new TopicsImportConflictError(
          `topic '${unchangedRow.label}' was not found in the final topic taxonomy`,
        )
      }
      rowTagIds.set(unchangedRow, unchangedId)
    }

    const importedRows = [
      ...diff.added,
      ...diff.updated.map(({ row: updatedRow }) => updatedRow),
      ...diff.unchanged,
    ]
    const resolvedParentIds = new Map<ParsedRow, string | null>()
    for (const importedRow of importedRows) {
      const childId = rowTagIds.get(importedRow)
      if (!childId) {
        throw new TopicsImportConflictError(
          `topic '${importedRow.label}' was not found in the final topic taxonomy`,
        )
      }
      if (!importedRow.parent) {
        resolvedParentIds.set(importedRow, null)
        continue
      }
      const parentId = finalLabelToId.get(importedRow.parent)
      if (!parentId) {
        throw new TopicsImportConflictError(
          `parent '${importedRow.parent}' was not found in the final topic taxonomy`,
        )
      }
      resolvedParentIds.set(importedRow, parentId)
    }

    const importedTagIds = [...new Set(rowTagIds.values())]
    if (importedTagIds.length > 0) {
      await em.query(
        `UPDATE tags SET parent_tag_id = NULL WHERE id = ANY($1::uuid[])`,
        [importedTagIds],
      )
    }

    for (const importedRow of importedRows) {
      const childId = rowTagIds.get(importedRow)!
      const parentId = resolvedParentIds.get(importedRow)
      if (!parentId) continue
      const parent = await findV1Topic(em, parentId)
      if (!parent) {
        throw new TopicsImportConflictError('parent must be a v1 topic')
      }
      await assertNoParentCycle(em, parent.id, childId)
      await em.query(`UPDATE tags SET parent_tag_id = $1 WHERE id = $2`, [
        parent.id,
        childId,
      ])
    }

    const changedTagIds = [...affectedTagIds]
    let enqueued = 0
    let runId: string | null = null
    if (reclassify && changedTagIds.length > 0) {
      const affectedDocuments: any[] = await em.query(
        `SELECT DISTINCT document_id
         FROM document_tags WHERE tag_id = ANY($1::uuid[])`,
        [changedTagIds],
      )
      const enqueueResult = await enqueueReclassifyDocumentIds(
        em,
        affectedDocuments.map((document) => document.document_id),
        changedTagIds.length === 1 ? changedTagIds[0] : null,
      )
      enqueued = enqueueResult.enqueued
      runId = enqueueResult.runId
    }

    if (identity) {
      await writeAudit(
        {
          ...auditActor(identity),
          action: 'tag_import',
          entityType: 'tag',
          entityId: null,
          after: {
            added: diff.added.length,
            updated: diff.updated.length,
            reclassify,
            enqueued,
            runId,
          },
        },
        em,
      )
    }

    return { applied: diff.added.length + diff.updated.length }
  })
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
    if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }

  const body = rows.map((r) =>
    [
      r.label,
      r.description ?? '',
      r.aliases ?? '',
      r.parent ?? '',
      'topic',
      r.id,
    ]
      .map(esc)
      .join(','),
  )

  return ['label,description,aliases,parent,facet,id', ...body].join('\n')
}

// --- Task 14: topic history (audit_log query) ---

export interface TopicHistoryEntry {
  at: string
  action: string
  source: string
  actor: string
  before: Record<string, any> | null
  after: Record<string, any> | null
}

export async function getTopicHistory(
  tagId: string,
): Promise<TopicHistoryEntry[]> {
  return AppDataSource.query(
    `SELECT al.at, al.action, al.source,
            COALESCE(u.username, al.source) AS actor,
            al.before, al.after
     FROM audit_log al
     LEFT JOIN users u ON u.id = al.actor_user_id
     WHERE al.entity_type = 'tag' AND al.entity_id = $1
     ORDER BY al.at DESC, al.id DESC
     LIMIT 20`,
    [tagId],
  )
}
