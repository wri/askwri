import { AppDataSource } from '../data-source'
import { Document } from '../entities/Document.entity'
import { writeAudit } from './audit'
import type { AdminIdentity } from '../../lib/auth/identity'
import { auditActor } from '../../lib/auth/identity'
import { basename } from 'path'
import { s3ClientConfig } from '../../lib/s3'
import { PROVENANCE_KEY } from '../../lib/metadataProvenance'

// Whitelisted editable metadata fields (entity property -> column handled by TypeORM)
export const EDITABLE_FIELDS = [
  'title',
  'titleEn',
  'doi',
  'language',
  'yearPublished',
  'publicationTitle',
  'articleType',
  'wriPrimaryOffice',
  'authors',
  'url',
  'datePublished',
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
  yearPublished?: number
}

export interface PaginationOptions {
  limit?: number
  offset?: number
}

// Whitelisted sort columns. Values are interpolated directly into ORDER BY, so
// this map is the ONLY source of column SQL — never a bound param (no injection).
const SORT_COLUMNS = {
  title: 'd.title',
  year_published: 'd.year_published',
  status: 'd.status',
  created_at: 'd.created_at',
} as const
export type SortKey = keyof typeof SORT_COLUMNS

export interface SortOptions {
  sort?: string
  dir?: string
}

/** True when sort/dir are absent or both in the whitelist. Route uses it for the 400. */
export function validateSort(sort?: string, dir?: string): boolean {
  // Object.hasOwn, NOT `sort in SORT_COLUMNS`: `in` traverses the prototype
  // chain, so ?sort=constructor / toString / __proto__ would validate, then the
  // lookup would interpolate a native-function string into ORDER BY → SQL
  // error → 500 instead of the promised 400.
  if (sort != null && !Object.hasOwn(SORT_COLUMNS, sort)) return false
  if (dir != null && dir !== 'asc' && dir !== 'desc') return false
  return true
}

export interface AdminDocumentListResult {
  items: AdminDocumentListItem[]
  total: number
}

export async function listAdminDocuments(
  filters: AdminDocumentFilters,
  pagination: PaginationOptions = {},
  sort: SortOptions = {},
): Promise<AdminDocumentListResult> {
  const where: string[] = ['1=1']
  const params: any[] = []
  const p = (v: any) => {
    params.push(v)
    return `$${params.length}`
  }
  if (filters.status) where.push(`d.status = ${p(filters.status)}`)
  if (filters.language)
    where.push(`d.languages @> ARRAY[${p(filters.language)}]::text[]`)
  if (filters.search)
    where.push(
      `(d.title ILIKE ${p('%' + filters.search + '%')} OR d.external_id ILIKE ${p('%' + filters.search + '%')} OR d.authors ILIKE ${p('%' + filters.search + '%')} OR d.doi ILIKE ${p('%' + filters.search + '%')} OR d.url ILIKE ${p('%' + filters.search + '%')})`,
    )
  if (filters.collectionId)
    where.push(`EXISTS (SELECT 1 FROM document_collections dc
                WHERE dc.document_id = d.id AND dc.collection_id = ${p(filters.collectionId)})`)
  if (filters.tagId)
    where.push(`EXISTS (SELECT 1 FROM document_tags dt
                WHERE dt.document_id = d.id AND dt.tag_id = ${p(filters.tagId)} AND dt.status = 'accepted')`)
  if (filters.yearPublished)
    where.push(`d.year_published = ${p(filters.yearPublished)}`)
  const whereClause = where.join(' AND ')
  const limit = pagination.limit ?? 500
  const offset = pagination.offset ?? 0
  // Items query: same WHERE + filter params, then LIMIT/OFFSET appended.
  const itemsParams = [...params, limit, offset]
  const limitParam = `$${params.length + 1}`
  const offsetParam = `$${params.length + 2}`
  // Object.hasOwn guard here too (defense in depth): a bare bracket lookup
  // would resolve prototype keys like 'constructor' to a function, not undefined.
  const sortColumn =
    sort.sort && Object.hasOwn(SORT_COLUMNS, sort.sort)
      ? SORT_COLUMNS[sort.sort as SortKey]
      : 'd.created_at'
  const sortDir = sort.dir === 'asc' ? 'ASC' : 'DESC'
  // d.id DESC stays as the deterministic tiebreaker (unchanged default: created_at DESC).
  const items = await AppDataSource.query(
    `SELECT d.id, d.external_id AS "externalId", d.title, d.language, d.status,
            d.year_published AS "yearPublished", d.created_at AS "createdAt"
     FROM documents d
     WHERE ${whereClause}
     ORDER BY ${sortColumn} ${sortDir}, d.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    itemsParams,
  )
  // Count query: same WHERE + filter params (no LIMIT/OFFSET).
  const countRows = await AppDataSource.query(
    `SELECT count(*)::int AS total FROM documents d WHERE ${whereClause}`,
    params,
  )
  return { items, total: countRows[0]?.total ?? 0 }
}

export interface AdminDocumentDetail {
  document: Document
  summaries: {
    language: string
    kind: string
    text: string
    source: string | null
  }[]
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
  latestJob: {
    status: string
    stage: string | null
    error: string | null
    attempts: number
  } | null
}

export async function getAdminDocumentDetail(
  id: string,
): Promise<AdminDocumentDetail | null> {
  const document = await AppDataSource.getRepository(Document).findOne({
    where: { id },
  })
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

/** Columns the document editor renders as a dropdown of values already in use
 * (issue #304). Both are free text in the schema with no canonical vocabulary,
 * so the corpus itself is the vocabulary: offering the existing spellings is
 * what stops "WRI Brasil"/"WRI Brazil" variants accumulating. The map is the
 * ONLY source of column SQL below — never a bound param (no injection). */
const DISTINCT_VALUE_COLUMNS = {
  articleType: 'article_type',
  wriPrimaryOffice: 'wri_primary_office',
} as const
export type DistinctValueField = keyof typeof DISTINCT_VALUE_COLUMNS

export type DocumentFieldValues = Record<DistinctValueField, string[]>

/** Distinct non-blank values per editable free-text column, alphabetical.
 * A value the editor holds that is absent here is still rendered by the client
 * as its own option, so this never has to be exhaustive. */
export async function listDocumentFieldValues(): Promise<DocumentFieldValues> {
  const entries = await Promise.all(
    (
      Object.entries(DISTINCT_VALUE_COLUMNS) as [DistinctValueField, string][]
    ).map(async ([field, column]) => {
      const rows = await AppDataSource.query(
        `SELECT DISTINCT ${column} AS value FROM documents
         WHERE ${column} IS NOT NULL AND btrim(${column}) <> ''
         ORDER BY value`,
      )
      return [field, rows.map((r: { value: string }) => r.value)] as const
    }),
  )
  return Object.fromEntries(entries) as DocumentFieldValues
}

export async function updateDocumentFields(
  id: string,
  patch: Partial<Record<EditableField, unknown>>,
  identity: AdminIdentity,
): Promise<{ updated: string[] } | { error: string } | null> {
  if ('yearPublished' in patch && patch.yearPublished != null) {
    const year = Number(patch.yearPublished)
    if (
      !Number.isFinite(year) ||
      !Number.isInteger(year) ||
      year < 1900 ||
      year > 2100
    ) {
      return { error: 'yearPublished must be an integer year' }
    }
    patch.yearPublished = year
  }
  if ('datePublished' in patch && patch.datePublished != null) {
    const dateStr = String(patch.datePublished)
    if (isNaN(Date.parse(dateStr))) {
      return { error: 'datePublished must be a valid date (YYYY-MM-DD)' }
    }
  }
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

  // Provenance: mark every edited metadata field 'human' so the worker
  // (parse/summarize) and CSV import never overwrite an admin edit. Both writers
  // only protect metadata_source='human'|'external'; without this the field
  // stays 'llm'/'external' and the next re-ingest silently clobbers the edit.
  // Keys are snake_case column names via the shared PROVENANCE_KEY map — the
  // convention the Python worker reads.
  const provenance: Record<string, string> = {}
  for (const field of updated) {
    provenance[PROVENANCE_KEY[field] ?? field] = 'human'
  }

  // Keep title_en in sync when an English doc's title is renamed and the admin
  // didn't set title_en explicitly: for English docs title_en === title. (Non-
  // English titles need translation, which only the worker can do — those are
  // refreshed on the next re-ingest, since their title_en provenance stays 'llm'.)
  if ('title' in after && doc.language === 'en' && !('titleEn' in after)) {
    before.titleEn = doc.titleEn
    doc.titleEn = doc.title
    after.titleEn = doc.titleEn
    provenance['title_en'] = 'llm' // derived copy — leave it in the worker's domain
    updated.push('titleEn')
  }

  // Transactional: the mutation and the audit row are committed atomically,
  // so a failure in the audit INSERT rolls back the mutation (no unaudited
  // mutation can persist).
  await AppDataSource.transaction(async (em) => {
    await em.getRepository(Document).save(doc)
    if (Object.keys(provenance).length > 0) {
      await em.query(
        `UPDATE documents SET metadata_source = metadata_source || $2::jsonb WHERE id = $1`,
        [id, JSON.stringify(provenance)],
      )
    }
    await em.query(
      `INSERT INTO audit_log (actor_user_id, source, action, entity_type, entity_id, before, after)
       VALUES ($1, $2, 'update', 'document', $3, $4, $5)`,
      [
        auditActor(identity).actorUserId,
        auditActor(identity).source,
        id,
        before,
        after,
      ],
    )
  })
  return { updated }
}

const ALLOWED_TARGET_STATUSES = new Set(['searchable', 'withdrawn'])

export async function setDocumentStatus(
  id: string,
  toStatus: string,
  identity: AdminIdentity,
): Promise<
  { fromStatus: string } | null | { error: string } | { forbidden: true }
> {
  if (!ALLOWED_TARGET_STATUSES.has(toStatus)) {
    return {
      error: `status must be one of: ${[...ALLOWED_TARGET_STATUSES].join(', ')}`,
    }
  }
  const repo = AppDataSource.getRepository(Document)
  const doc = await repo.findOne({ where: { id } })
  if (!doc) return null
  const fromStatus = doc.status
  // Reversing an admin takedown is admin-only: editors may promote documents
  // through review, but not restore a withdrawn one.
  if (fromStatus === 'withdrawn' && identity.role !== 'admin') {
    return { forbidden: true }
  }
  if (fromStatus === toStatus) return { fromStatus }
  // Promote is restricted: only needs_review → searchable (design §7.9/§11.311).
  // Editors cannot bypass the pipeline by promoting draft/error/processing docs.
  if (
    toStatus === 'searchable' &&
    fromStatus !== 'needs_review' &&
    fromStatus !== 'withdrawn'
  ) {
    return { error: 'can only promote needs_review → searchable' }
  }
  doc.status = toStatus
  // Transactional: mutation + audit committed atomically.
  await AppDataSource.transaction(async (em) => {
    await em.getRepository(Document).save(doc)
    await em.query(
      `INSERT INTO audit_log (actor_user_id, source, action, entity_type, entity_id, before, after)
       VALUES ($1, $2, 'lifecycle', 'document', $3, $4, $5)`,
      [
        auditActor(identity).actorUserId,
        auditActor(identity).source,
        id,
        { status: fromStatus },
        { status: toStatus },
      ],
    )
  })
  return { fromStatus }
}

/** Re-enqueue ingestion for a document unless an open job already exists. */
export async function reenqueueIngestion(
  id: string,
  identity: AdminIdentity,
): Promise<{ jobId: string } | { error: string } | null> {
  const doc = await AppDataSource.getRepository(Document).findOne({
    where: { id },
  })
  if (!doc) return null
  // The partial unique index ingestion_jobs_one_open_per_doc is the arbiter:
  // ON CONFLICT (document_id) WHERE <index predicate> infers it, making the
  // open-job check and the insert one atomic statement (no enqueue race).
  const [job] = await AppDataSource.query(
    `INSERT INTO ingestion_jobs (document_id, status) VALUES ($1, 'queued')
     ON CONFLICT (document_id) WHERE status IN ('queued', 'running') DO NOTHING
     RETURNING id`,
    [id],
  )
  if (!job) return { error: 'an open ingestion job already exists' }
  await writeAudit({
    ...auditActor(identity),
    action: 'create',
    entityType: 'ingestion_job',
    entityId: job.id,
    after: { documentId: id, status: 'queued' },
  })
  return { jobId: job.id }
}

/**
 * Update a single document_summaries row (by document_id + language + kind).
 * Any editable row (any source) can be saved. The mutation and the audit row
 * are committed atomically.
 */
export async function updateDocumentSummary(
  documentId: string,
  language: string,
  kind: string,
  text: string,
  identity: AdminIdentity,
): Promise<{ updated: boolean } | { error: string } | null> {
  if (!text.trim()) return { error: 'summary text must not be empty' }
  if (text.length > 5000)
    return { error: 'summary text must not exceed 5000 chars' }
  const existing: { source: string; text: string }[] =
    await AppDataSource.query(
      `SELECT source, text FROM document_summaries
     WHERE document_id = $1 AND language = $2 AND kind = $3`,
      [documentId, language, kind],
    )
  if (existing.length === 0) return null
  const row = existing[0]
  if (row.text === text) return { updated: false }
  const before = { language, kind, text: row.text, source: row.source }
  const after = { language, kind, text, source: 'human' }
  await AppDataSource.transaction(async (em) => {
    // A person-edited summary must be stamped source='human' so the worker's
    // summarize stage (which only preserves 'human'/'external') never
    // overwrites it on re-ingest.
    await em.query(
      `UPDATE document_summaries SET text = $1, source = 'human'
       WHERE document_id = $2 AND language = $3 AND kind = $4`,
      [text, documentId, language, kind],
    )
    await em.query(
      `INSERT INTO audit_log (actor_user_id, source, action, entity_type, entity_id, before, after)
       VALUES ($1, $2, 'update', 'document_summary', $3, $4, $5)`,
      [
        auditActor(identity).actorUserId,
        auditActor(identity).source,
        documentId,
        before,
        after,
      ],
    )
  })
  return { updated: true }
}

/**
 * Hard-delete a document: permanently removes the documents row (CASCADE to
 * document_texts/chunks/summaries/tags/collections; ingestion_jobs FK is SET NULL
 * so the job survives with document_id=NULL), deletes the S3 PDF object, and
 * writes an audit tombstone (action='delete', before={title, external_id},
 * after=null). Admin-only (the route enforces the role). Returns false if the
 * document does not exist.
 */
export async function purgeDocument(
  id: string,
  identity: AdminIdentity,
): Promise<boolean> {
  const repo = AppDataSource.getRepository(Document)
  const doc = await repo.findOne({ where: { id } })
  if (!doc) return false

  // Sanitize the S3 key: basename + documents prefix (same as the file route).
  const filename = doc.s3Key ? basename(doc.s3Key) : null
  const documentsPrefix = process.env.DOCUMENTS_S3_PREFIX || 'documents/'
  const safeKey = filename ? `${documentsPrefix}${filename}` : null
  const bucket = process.env.DOCUMENTS_S3_BUCKET

  // Delete the S3 object BEFORE the DB row (best-effort: a missing object is
  // not an error — the doc may have no PDF, or it was already removed).
  if (bucket && safeKey) {
    try {
      const { DeleteObjectCommand, S3Client } =
        await import('@aws-sdk/client-s3')
      const s3 = new S3Client(s3ClientConfig())
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: safeKey }))
    } catch {
      // Best-effort: don't block the DB delete on an S3 failure (the object
      // may not exist, or S3 may be unreachable in a local env without MinIO).
    }
  }

  const before = { title: doc.title, external_id: doc.externalId }

  await AppDataSource.transaction(async (em) => {
    // The child tables cascade (ON DELETE CASCADE); ingestion_jobs is SET NULL.
    await em.getRepository(Document).delete(id)
    // Audit tombstone: after=null (the entity is gone).
    await em.query(
      `INSERT INTO audit_log (actor_user_id, source, action, entity_type, entity_id, before, after)
       VALUES ($1, $2, 'delete', 'document', $3, $4, NULL)`,
      [
        auditActor(identity).actorUserId,
        auditActor(identity).source,
        id,
        before,
      ],
    )
  })
  return true
}
