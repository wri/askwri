import { AppDataSource } from '../data-source'
import { Tag } from '../entities/Tag.entity'
import { writeAudit } from './audit'
import type { AdminIdentity } from '../../lib/auth/identity'
import { auditActor } from '../../lib/auth/identity'

export interface TagWithCounts {
  id: string
  facet: string
  valueId: string
  taxonomyVersion: string
  acceptedCount: number
  suggestedCount: number
}

export async function listTagsWithCounts(): Promise<TagWithCounts[]> {
  return AppDataSource.query(`
    SELECT t.id, t.facet, t.value_id AS "valueId", t.taxonomy_version AS "taxonomyVersion",
           count(*) FILTER (WHERE dt.status = 'accepted')::int  AS "acceptedCount",
           count(*) FILTER (WHERE dt.status = 'suggested')::int AS "suggestedCount"
    FROM tags t
    LEFT JOIN document_tags dt ON dt.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.facet, t.value_id
  `)
}

export async function createTag(
  facet: string,
  valueId: string,
  identity: AdminIdentity,
): Promise<Tag | { error: string }> {
  // Validate facet is non-empty and valueId is non-empty.
  if (!facet.trim() || !valueId.trim()) {
    return { error: 'facet and valueId must be non-empty' }
  }
  const repo = AppDataSource.getRepository(Tag)
  const existing = await repo.findOne({ where: { facet, valueId, taxonomyVersion: 'v1' } })
  if (existing) return { error: 'tag already exists' }
  const tag = await repo.save(repo.create({ facet, valueId, taxonomyVersion: 'v1' }))
  await writeAudit({
    ...auditActor(identity),
    action: 'create',
    entityType: 'tag',
    entityId: tag.id,
    after: { facet, valueId, taxonomyVersion: 'v1' },
  })
  return tag
}

export type DeleteTagResult =
  | { deleted: true }
  | { deleted: false; reason: 'in_use' | 'not_found'; error: string }

export async function deleteTagIfUnused(
  id: string,
  identity: AdminIdentity,
): Promise<DeleteTagResult> {
  const tag = await AppDataSource.getRepository(Tag).findOne({ where: { id } })
  if (!tag) return { deleted: false, reason: 'not_found', error: 'not found' }
  // Atomic: the NOT EXISTS guard and the delete run as one statement, so a
  // concurrent tag application cannot slip between check and delete.
  // pg driver returns [rows, rowCount] for DELETE.
  const [rows] = await AppDataSource.query(
    `DELETE FROM tags
     WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM document_tags WHERE tag_id = $1)
     RETURNING id`,
    [id],
  )
  if (!Array.isArray(rows) || rows.length === 0) {
    return { deleted: false, reason: 'in_use', error: 'tag is applied to one or more documents' }
  }
  await writeAudit({
    ...auditActor(identity),
    action: 'delete',
    entityType: 'tag',
    entityId: id,
    before: { facet: tag.facet, valueId: tag.valueId },
  })
  return { deleted: true }
}

/**
 * Accept or reject a tag on a document. Sets source='human' so the worker's
 * classify stage (which skips source='human'|'external' rows) can never
 * overwrite a human decision — Scope decision 7. The prior row is preserved
 * in the audit 'before'.
 */
export async function decideDocumentTag(
  documentId: string,
  tagId: string,
  decision: 'accepted' | 'rejected',
  identity: AdminIdentity,
): Promise<{ ok: true } | { error: string }> {
  const [row] = await AppDataSource.query(
    `SELECT source, status, confidence::float AS confidence, model_version AS "modelVersion"
     FROM document_tags WHERE document_id = $1 AND tag_id = $2`,
    [documentId, tagId],
  )
  if (!row) return { error: 'tag is not on this document' }
  await AppDataSource.query(
    `UPDATE document_tags SET status = $3, source = 'human'
     WHERE document_id = $1 AND tag_id = $2`,
    [documentId, tagId, decision],
  )
  await writeAudit({
    ...auditActor(identity),
    action: 'tag_decision',
    entityType: 'document',
    entityId: documentId,
    before: { tagId, ...row },
    after: { tagId, status: decision, source: 'human' },
  })
  return { ok: true }
}

/** Attach an existing taxonomy tag to a document as an accepted human tag. */
export async function addHumanTag(
  documentId: string,
  tagId: string,
  identity: AdminIdentity,
): Promise<{ ok: true } | { error: string }> {
  const existing = await AppDataSource.query(
    `SELECT 1 FROM document_tags WHERE document_id = $1 AND tag_id = $2`,
    [documentId, tagId],
  )
  if (existing.length > 0) return { error: 'tag already on document — use accept/reject' }
  await AppDataSource.query(
    `INSERT INTO document_tags (document_id, tag_id, source, status)
     VALUES ($1, $2, 'human', 'accepted')`,
    [documentId, tagId],
  )
  await writeAudit({
    ...auditActor(identity),
    action: 'tag_decision',
    entityType: 'document',
    entityId: documentId,
    after: { tagId, status: 'accepted', source: 'human' },
  })
  return { ok: true }
}

/** Physically remove a tag from a document (DELETE). Unlike accept/reject which
 * flips status, this deletes the document_tags row entirely. Records a 'before'
 * audit snapshot so the prior tag assignment is preserved. */
export async function removeDocumentTag(
  documentId: string,
  tagId: string,
  identity: AdminIdentity,
): Promise<{ ok: true } | { error: string }> {
  const [row] = await AppDataSource.query(
    `SELECT source, status, confidence::float AS confidence, model_version AS "modelVersion"
     FROM document_tags WHERE document_id = $1 AND tag_id = $2`,
    [documentId, tagId],
  )
  if (!row) return { error: 'tag is not on this document' }
  await AppDataSource.query(
    `DELETE FROM document_tags WHERE document_id = $1 AND tag_id = $2`,
    [documentId, tagId],
  )
  await writeAudit({
    ...auditActor(identity),
    action: 'tag_decision',
    entityType: 'document',
    entityId: documentId,
    before: { tagId, ...row },
    after: { tagId, removed: true },
  })
  return { ok: true }
}

/** Rename a tag's facet and/or valueId (admin-only). Writes an audit row with
 * before/after. Validates non-empty values. */
export async function renameTag(
  id: string,
  patch: Partial<{ facet: string; valueId: string }>,
  identity: AdminIdentity,
): Promise<Tag | null | { error: string }> {
  const repo = AppDataSource.getRepository(Tag)
  const tag = await repo.findOne({ where: { id } })
  if (!tag) return null

  const before: Record<string, any> = {}
  const after: Record<string, any> = {}
  if (patch.facet !== undefined) {
    const trimmed = patch.facet.trim()
    if (!trimmed) return { error: 'facet must be non-empty' }
    if (trimmed !== tag.facet) {
      before.facet = tag.facet
      after.facet = trimmed
      tag.facet = trimmed
    }
  }
  if (patch.valueId !== undefined) {
    const trimmed = patch.valueId.trim()
    if (!trimmed) return { error: 'valueId must be non-empty' }
    if (trimmed !== tag.valueId) {
      before.valueId = tag.valueId
      after.valueId = trimmed
      tag.valueId = trimmed
    }
  }
  if (Object.keys(after).length === 0) return tag // no-op
  await repo.save(tag)
  await writeAudit({
    ...auditActor(identity),
    action: 'update',
    entityType: 'tag',
    entityId: id,
    before,
    after,
  })
  return tag
}
