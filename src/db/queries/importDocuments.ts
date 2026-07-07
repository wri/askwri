import { AppDataSource } from '../data-source'
import { Document } from '../entities/Document.entity'
import { IngestionJob } from '../entities/IngestionJob.entity'
import { writeAudit } from './audit'
import type { AdminIdentity } from '../../lib/auth/identity'
import { auditActor } from '../../lib/auth/identity'

// Mirrors LANGUAGE_MAP in search-service/scripts/migrate_csv_to_postgres.py
// plus Phase 1 amendment: bahasa → id
const LANGUAGE_MAP: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  portuguese: 'pt',
  chinese: 'zh',
  bahasa: 'id',
}

export interface ImportRow {
  file_path: string
  metadata: Record<string, any>
  summary?: string
}

export interface MappedDocument {
  externalId: string
  title: string | null
  language: string
  languages: string[]
  yearPublished: number | null
  publicationTitle: string | null
  s3Key: string
  sourceMetadata: Record<string, any>
  doi: string | null
  articleType: string | null
  wriPrimaryOffice: string | null
  authors: string | null
  url: string | null
  datePublished: string | null
}

export interface RowDecision {
  externalId: string
  action: 'created' | 'updated' | 'skipped' | 'error'
  reason?: string
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
  jobs: number
  decisions?: RowDecision[]
}

// external_id = file_path minus trailing .pdf (case-insensitive, so CSV-imported
// and intake-worker external_ids agree) and any directory part
export function deriveExternalId(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath
  return base.toLowerCase().endsWith('.pdf') ? base.slice(0, -4) : base
}

// Mirrors map_languages() in the Python script.
// 'English; Spanish' -> { primary: 'en', all: ['en', 'es'] }
// Unknown labels are kept out; if nothing maps, defaults to ['en'].
export function mapLanguages(raw: unknown): { primary: string; all: string[] } {
  if (!raw || typeof raw !== 'string') {
    return { primary: 'en', all: ['en'] }
  }
  const parts = raw
    .replace(/;/g, ',')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0)
  const codes = parts.filter((p) => p in LANGUAGE_MAP).map((p) => LANGUAGE_MAP[p])
  if (codes.length === 0) {
    return { primary: 'en', all: ['en'] }
  }
  return { primary: codes[0], all: codes }
}

// Mirrors parse_year() in the Python script: int(str(raw).strip()[:4])
export function parseYear(value: unknown): number | null {
  try {
    const n = parseInt(String(value).trim().slice(0, 4), 10)
    return isNaN(n) ? null : n
  } catch {
    return null
  }
}

// Parse CSV "Date published" (M/D/YYYY, e.g. "8/17/2021") → ISO date string (YYYY-MM-DD).
// Returns null for unparseable values. Mirrors the migration's to_date(..., 'MM/DD/YYYY').
export function parseDatePublished(value: unknown): string | null {
  if (!value || typeof value !== 'string') return null
  const parts = value.trim().split('/')
  if (parts.length !== 3) return null
  const [m, d, y] = parts
  const month = parseInt(m, 10)
  const day = parseInt(d, 10)
  const year = parseInt(y, 10)
  if (!month || !day || !year) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Validate file_path for s3_key construction (D3 security fix):
// - must be a string
// - must not contain path traversal (..)
// - the basename must end with .pdf
// - if it has a directory prefix, it must be the documents_s3_prefix
// Returns the sanitized basename on success, or an error message on failure.
export function validateFilePath(filePath: string): { ok: true; base: string } | { ok: false; error: string } {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { ok: false, error: 'invalid file_path' }
  }
  if (filePath.includes('..')) {
    return { ok: false, error: 'file_path must not contain path traversal (..)' }
  }
  const base = filePath.split('/').pop() ?? filePath
  if (!base.toLowerCase().endsWith('.pdf')) {
    return { ok: false, error: `${base}: file_path must be a .pdf file` }
  }
  // If file_path has a directory prefix, it must be the documents prefix
  const documentsS3Prefix = process.env.DOCUMENTS_S3_PREFIX || 'documents/'
  if (filePath.includes('/') && !filePath.startsWith(documentsS3Prefix)) {
    return { ok: false, error: `${base}: file_path must be a bare filename or under the documents prefix (${documentsS3Prefix})` }
  }
  return { ok: true, base }
}

export function mapRowToDocument(row: ImportRow): MappedDocument {
  const raw = row.metadata ?? {}
  const externalId = deriveExternalId(row.file_path)
  const { primary, all } = mapLanguages(raw['languages'])
  // Same final fallback as the migration script: title defaults to the external id
  const title = (raw['Article Title'] as string | undefined) || (raw['Publication Title'] as string | undefined) || externalId
  const publicationTitle = (raw['Publication Title'] as string | undefined) || null
  const yearPublished = parseYear(raw['YEAR published'])
  const documentsS3Prefix = process.env.DOCUMENTS_S3_PREFIX || 'documents/'
  const base = row.file_path.split('/').pop() ?? row.file_path
  const s3Key = `${documentsS3Prefix}${base}`

  return {
    externalId,
    title,
    language: primary,
    languages: all,
    yearPublished,
    publicationTitle,
    s3Key,
    sourceMetadata: {
      file_path: row.file_path,
      summary: row.summary ?? '',
      metadata: raw,
    },
    doi: (raw['DOI'] as string | undefined) || null,
    articleType: (raw['article_type'] as string | undefined) || null,
    wriPrimaryOffice: (raw['wri_primary_office'] as string | undefined) || null,
    authors: (raw['All authors'] as string | undefined) || null,
    url: (raw['URL'] as string | undefined) || null,
    datePublished: parseDatePublished(raw['Date published']),
  }
}

// SEED semantics: updated = doc exists and at least one currently-NULL column
// would be filled by the new data. skipped = nothing to change.
export function classifyUpsert(
  existing: Document | null,
  mapped: MappedDocument,
): 'created' | 'updated' | 'skipped' {
  if (!existing) return 'created'

  const wouldFill =
    (existing.title === null && mapped.title !== null) ||
    (existing.language === null && mapped.language !== null) ||
    (existing.languages === null && mapped.languages !== null) ||
    (existing.yearPublished === null && mapped.yearPublished !== null) ||
    (existing.publicationTitle === null && mapped.publicationTitle !== null) ||
    (existing.sourceMetadata === null && mapped.sourceMetadata !== null) ||
    (existing.doi === null && mapped.doi !== null) ||
    (existing.articleType === null && mapped.articleType !== null) ||
    (existing.wriPrimaryOffice === null && mapped.wriPrimaryOffice !== null) ||
    (existing.authors === null && mapped.authors !== null) ||
    (existing.url === null && mapped.url !== null) ||
    (existing.datePublished === null && mapped.datePublished !== null)

  return wouldFill ? 'updated' : 'skipped'
}

export async function importDocuments(
  rows: ImportRow[],
  options: { dryRun: boolean },
  identity?: AdminIdentity,
): Promise<ImportResult> {
  const docRepo = AppDataSource.getRepository(Document)

  const decisions: RowDecision[] = []
  let created = 0
  let updated = 0
  let skipped = 0
  let jobs = 0

  // Seed semantics, not atomic: a mid-import failure leaves earlier rows
  // committed (safe — re-running is idempotent).
  for (const row of rows) {
    // Per-row validation: bad rows get an error decision instead of throwing
    // mid-loop (which would abandon the rest of the batch).
    if (typeof row.file_path !== 'string' || row.file_path.trim() === '') {
      decisions.push({ externalId: '', action: 'error', reason: 'invalid file_path' })
      continue
    }
    // D3 security fix: validate file_path before using it as s3_key
    const validation = validateFilePath(row.file_path)
    if (!validation.ok) {
      decisions.push({ externalId: deriveExternalId(row.file_path), action: 'error', reason: validation.error })
      continue
    }

    const mapped = mapRowToDocument(row)
    const existing = await docRepo.findOne({ where: { externalId: mapped.externalId } })
    const action = classifyUpsert(existing, mapped)
    decisions.push({ externalId: mapped.externalId, action })

    if (!options.dryRun) {
      let docId: string | null = null

      if (action === 'created') {
        const doc = docRepo.create({
          externalId: mapped.externalId,
          title: mapped.title,
          language: mapped.language,
          languages: mapped.languages,
          yearPublished: mapped.yearPublished,
          publicationTitle: mapped.publicationTitle,
          s3Key: mapped.s3Key,
          sourceMetadata: mapped.sourceMetadata,
          status: 'draft',
          doi: mapped.doi,
          articleType: mapped.articleType,
          wriPrimaryOffice: mapped.wriPrimaryOffice,
          authors: mapped.authors,
          url: mapped.url,
          datePublished: mapped.datePublished,
        })
        const saved = await docRepo.save(doc)
        docId = saved.id
        created++
      } else if (action === 'updated') {
        const updates: Partial<Document> = {}
        if (existing!.title === null && mapped.title !== null) updates.title = mapped.title
        if (existing!.language === null) updates.language = mapped.language
        if (existing!.languages === null) updates.languages = mapped.languages
        if (existing!.yearPublished === null && mapped.yearPublished !== null) updates.yearPublished = mapped.yearPublished
        if (existing!.publicationTitle === null && mapped.publicationTitle !== null) updates.publicationTitle = mapped.publicationTitle
        if (existing!.sourceMetadata === null) updates.sourceMetadata = mapped.sourceMetadata
        if (existing!.doi === null && mapped.doi !== null) updates.doi = mapped.doi
        if (existing!.articleType === null && mapped.articleType !== null) updates.articleType = mapped.articleType
        if (existing!.wriPrimaryOffice === null && mapped.wriPrimaryOffice !== null) updates.wriPrimaryOffice = mapped.wriPrimaryOffice
        if (existing!.authors === null && mapped.authors !== null) updates.authors = mapped.authors
        if (existing!.url === null && mapped.url !== null) updates.url = mapped.url
        if (existing!.datePublished === null && mapped.datePublished !== null) updates.datePublished = mapped.datePublished
        await docRepo.update({ externalId: mapped.externalId }, updates)
        docId = existing!.id
        updated++
      } else {
        // skipped — no doc write, but still attempt job creation (D2 fix:
        // a parked needs_review job should NOT block re-ingestion).
        docId = existing!.id
        skipped++
      }

      // D2 fix: atomic job creation — ON CONFLICT (document_id) WHERE status IN
      // ('queued','running') DO NOTHING. This replaces the old read-then-insert
      // race (unhandled 23505) and drops needs_review from the open set (a
      // parked needs_review job no longer blocks a fresh import). Mirrors
      // documentsAdmin.ts reenqueueIngestion.
      if (docId) {
        const [job] = await AppDataSource.query(
          `INSERT INTO ingestion_jobs (document_id, status) VALUES ($1, 'queued')
           ON CONFLICT (document_id) WHERE status IN ('queued', 'running') DO NOTHING
           RETURNING id`,
          [docId],
        )
        if (job) {
          jobs++
        }
      }
    }
  }

  if (options.dryRun) {
    skipped = decisions.filter((d) => d.action === 'skipped').length
    created = decisions.filter((d) => d.action === 'created').length
    updated = decisions.filter((d) => d.action === 'updated').length
    return { created, updated, skipped, jobs: 0, decisions }
  }

  // D5 fix: audit with the actor identity (was hardcoded 'external' with no actor).
  const actor = identity ? auditActor(identity) : { actorUserId: null, source: 'system' as const }
  await writeAudit({
    ...actor,
    action: 'import',
    entityType: 'documents',
    after: { created, updated, skipped, jobs },
  })

  return { created, updated, skipped, jobs }
}
