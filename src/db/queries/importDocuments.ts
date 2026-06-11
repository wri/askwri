import { AppDataSource } from '../data-source'
import { Document } from '../entities/Document.entity'
import { IngestionJob } from '../entities/IngestionJob.entity'

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

export function mapRowToDocument(row: ImportRow): MappedDocument {
  const raw = row.metadata ?? {}
  const externalId = deriveExternalId(row.file_path)
  const { primary, all } = mapLanguages(raw['languages'])
  // Same final fallback as the migration script: title defaults to the external id
  const title = (raw['Article Title'] as string | undefined) || (raw['Publication Title'] as string | undefined) || externalId
  const publicationTitle = (raw['Publication Title'] as string | undefined) || null
  const yearPublished = parseYear(raw['YEAR published'])
  const s3Key = row.file_path

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
    (existing.sourceMetadata === null && mapped.sourceMetadata !== null)

  return wouldFill ? 'updated' : 'skipped'
}

const OPEN_STATUSES = ['queued', 'running', 'needs_review']

export async function importDocuments(
  rows: ImportRow[],
  options: { dryRun: boolean },
): Promise<ImportResult> {
  const docRepo = AppDataSource.getRepository(Document)
  const jobRepo = AppDataSource.getRepository(IngestionJob)

  const decisions: RowDecision[] = []
  let created = 0
  let updated = 0
  let skipped = 0
  let jobs = 0

  // Seed semantics, not atomic: a mid-import failure leaves earlier rows
  // committed (safe — re-running is idempotent). Do not invoke concurrently
  // for the same rows: the open-job check below is read-then-insert.
  for (const row of rows) {
    // Per-row validation: bad rows get an error decision instead of throwing
    // mid-loop (which would abandon the rest of the batch).
    if (typeof row.file_path !== 'string' || row.file_path.trim() === '') {
      decisions.push({ externalId: '', action: 'error', reason: 'invalid file_path' })
      continue
    }
    const mapped = mapRowToDocument(row)
    const existing = await docRepo.findOne({ where: { externalId: mapped.externalId } })
    const action = classifyUpsert(existing, mapped)
    decisions.push({ externalId: mapped.externalId, action })

    if (!options.dryRun) {
      let docId: string

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
        await docRepo.update({ externalId: mapped.externalId }, updates)
        docId = existing!.id
        updated++
      } else {
        // skipped — no write
        skipped++
        continue
      }

      // Create ingestion job if no open job exists for this document
      const openJob = await jobRepo.findOne({
        where: OPEN_STATUSES.map((s) => ({ documentId: docId, status: s })) as any,
      })
      if (!openJob) {
        const job = jobRepo.create({ documentId: docId, status: 'queued' })
        await jobRepo.save(job)
        jobs++
      }
    }
  }

  if (options.dryRun) {
    skipped = decisions.filter((d) => d.action === 'skipped').length
    created = decisions.filter((d) => d.action === 'created').length
    updated = decisions.filter((d) => d.action === 'updated').length
    return { created, updated, skipped, jobs: 0, decisions }
  }

  // Audit log — one row for the whole import call
  await AppDataSource.query(
    `INSERT INTO audit_log (source, action, entity_type, after) VALUES ($1, $2, $3, $4)`,
    ['external', 'import', 'documents', JSON.stringify({ created, updated, skipped, jobs })],
  )

  return { created, updated, skipped, jobs }
}
