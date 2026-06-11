import { AppDataSource } from '../data-source'
import { Document } from '../entities/Document.entity'
import { writeAudit } from './audit'
import type { AdminIdentity } from '../../lib/auth/identity'
import { auditActor } from '../../lib/auth/identity'

// Whitelisted editable metadata fields (entity property -> column handled by TypeORM)
export const EDITABLE_FIELDS = [
  'title',
  'titleEn',
  'doi',
  'abstract',
  'language',
  'yearPublished',
  'publicationTitle',
  'articleType',
  'wriPrimaryOffice',
] as const
export type EditableField = (typeof EDITABLE_FIELDS)[number]

export interface AdminDocumentListItem {
  id: string
  externalId: string
  title: string | null
  language: string | null
  status: string
  yearPublished: number | null
  createdAt: string
}

export interface AdminDocumentFilters {
  status?: string
  language?: string
  collectionId?: string
  tagId?: string
  search?: string
}

export async function listAdminDocuments(
  filters: AdminDocumentFilters,
): Promise<AdminDocumentListItem[]> {
  const where: string[] = ['1=1']
  const params: any[] = []
  const p = (v: any) => {
    params.push(v)
    return `$${params.length}`
  }
  if (filters.status) where.push(`d.status = ${p(filters.status)}`)
  if (filters.language) where.push(`d.language = ${p(filters.language)}`)
  if (filters.search) where.push(`(d.title ILIKE ${p('%' + filters.search + '%')} OR d.external_id ILIKE ${p('%' + filters.search + '%')})`)
  if (filters.collectionId)
    where.push(`EXISTS (SELECT 1 FROM document_collections dc
                WHERE dc.document_id = d.id AND dc.collection_id = ${p(filters.collectionId)})`)
  if (filters.tagId)
    where.push(`EXISTS (SELECT 1 FROM document_tags dt
                WHERE dt.document_id = d.id AND dt.tag_id = ${p(filters.tagId)} AND dt.status = 'accepted')`)
  return AppDataSource.query(
    `SELECT d.id, d.external_id AS "externalId", d.title, d.language, d.status,
            d.year_published AS "yearPublished", d.created_at AS "createdAt"
     FROM documents d
     WHERE ${where.join(' AND ')}
     ORDER BY d.created_at DESC
     LIMIT 500`,
    params,
  )
}

export interface AdminDocumentDetail {
  document: Document
  summaries: { language: string; kind: string; text: string; source: string | null }[]
  tags: {
    tagId: string
    facet: string
    valueId: string
    source: string
    status: string
    confidence: number | null
    modelVersion: string | null
  }[]
  collections: { id: string; name: string; slug: string }[]
  latestJob: { status: string; stage: string | null; error: string | null; attempts: number } | null
}

export async function getAdminDocumentDetail(id: string): Promise<AdminDocumentDetail | null> {
  const document = await AppDataSource.getRepository(Document).findOne({ where: { id } })
  if (!document) return null
  const summaries = await AppDataSource.query(
    `SELECT language, kind, text, source FROM document_summaries
     WHERE document_id = $1 ORDER BY language, kind`,
    [id],
  )
  const tags = await AppDataSource.query(
    `SELECT dt.tag_id AS "tagId", t.facet, t.value_id AS "valueId", dt.source, dt.status,
            dt.confidence::float AS confidence, dt.model_version AS "modelVersion"
     FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
     WHERE dt.document_id = $1
     ORDER BY t.facet, t.value_id`,
    [id],
  )
  const collections = await AppDataSource.query(
    `SELECT c.id, c.name, c.slug
     FROM document_collections dc JOIN collections c ON c.id = dc.collection_id
     WHERE dc.document_id = $1 ORDER BY c.name`,
    [id],
  )
  const jobs = await AppDataSource.query(
    `SELECT status, stage, error, attempts FROM ingestion_jobs
     WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [id],
  )
  return { document, summaries, tags, collections, latestJob: jobs[0] ?? null }
}

export async function updateDocumentFields(
  id: string,
  patch: Partial<Record<EditableField, unknown>>,
  identity: AdminIdentity,
): Promise<{ updated: string[] } | null> {
  const repo = AppDataSource.getRepository(Document)
  const doc = await repo.findOne({ where: { id } })
  if (!doc) return null
  const before: Record<string, any> = {}
  const after: Record<string, any> = {}
  for (const field of EDITABLE_FIELDS) {
    if (field in patch && patch[field] !== (doc as any)[field]) {
      before[field] = (doc as any)[field]
      after[field] = patch[field]
      ;(doc as any)[field] = patch[field]
    }
  }
  const updated = Object.keys(after)
  if (updated.length === 0) return { updated }
  await repo.save(doc)
  await writeAudit({
    ...auditActor(identity),
    action: 'update',
    entityType: 'document',
    entityId: id,
    before,
    after,
  })
  return { updated }
}

const ALLOWED_TARGET_STATUSES = new Set(['searchable', 'withdrawn'])

export async function setDocumentStatus(
  id: string,
  toStatus: string,
  identity: AdminIdentity,
): Promise<{ fromStatus: string } | null | { error: string }> {
  if (!ALLOWED_TARGET_STATUSES.has(toStatus)) {
    return { error: `status must be one of: ${[...ALLOWED_TARGET_STATUSES].join(', ')}` }
  }
  const repo = AppDataSource.getRepository(Document)
  const doc = await repo.findOne({ where: { id } })
  if (!doc) return null
  const fromStatus = doc.status
  if (fromStatus === toStatus) return { fromStatus }
  doc.status = toStatus
  await repo.save(doc)
  await writeAudit({
    ...auditActor(identity),
    action: 'lifecycle',
    entityType: 'document',
    entityId: id,
    before: { status: fromStatus },
    after: { status: toStatus },
  })
  return { fromStatus }
}

/** Re-enqueue ingestion for a document unless an open job already exists. */
export async function reenqueueIngestion(
  id: string,
  identity: AdminIdentity,
): Promise<{ jobId: string } | { error: string } | null> {
  const doc = await AppDataSource.getRepository(Document).findOne({ where: { id } })
  if (!doc) return null
  const open = await AppDataSource.query(
    `SELECT id FROM ingestion_jobs
     WHERE document_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
    [id],
  )
  if (open.length > 0) return { error: 'an open ingestion job already exists' }
  const [job] = await AppDataSource.query(
    `INSERT INTO ingestion_jobs (document_id, status) VALUES ($1, 'queued') RETURNING id`,
    [id],
  )
  await writeAudit({
    ...auditActor(identity),
    action: 'create',
    entityType: 'ingestion_job',
    entityId: job.id,
    after: { documentId: id, status: 'queued' },
  })
  return { jobId: job.id }
}
