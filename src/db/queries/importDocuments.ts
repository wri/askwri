import { AppDataSource } from '../data-source'
import { Document } from '../entities/Document.entity'
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

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** Legacy JSON-blob format: { file_path, metadata: {Article Title, ...}, summary } */
export interface ImportRow {
  file_path: string
  metadata: Record<string, any>
  summary?: string
}

/** Flat CSV format: each column maps directly to a DB field (DB column names). */
export interface FlatImportRow {
  file_path?: string
  external_id?: string
  doi?: string
  title?: string
  authors?: string
  year_published?: string | number
  publication_title?: string
  article_type?: string
  wri_primary_office?: string
  languages?: string
  url?: string
  date_published?: string
  summary?: string
  short_summary?: string
  // Legacy human-name aliases (auto-mapped to the DB column names above)
  'Article Title'?: string
  'Publication Title'?: string
  'All authors'?: string
  'YEAR published'?: string
  'Date published'?: string
  [key: string]: string | number | undefined
}

/** Union type — the API accepts either shape. Auto-detected by isLegacyRow(). */
export type AnyImportRow = ImportRow | FlatImportRow

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
  summary: string | null
  shortSummary: string | null
  /** Whether this row is flat (overwrite mode) or legacy (fill-only-empty). */
  isFlat: boolean
}

export interface FieldChange {
  field: string
  before: string | null
  after: string | null
  overwrite: boolean
  protected: boolean
}

export interface RowDecision {
  externalId: string
  action: 'created' | 'updated' | 'skipped' | 'error'
  reason?: string
  changes?: FieldChange[]
  warnings?: string[]
  matchKey?: string
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
  jobs: number
  decisions?: RowDecision[]
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Auto-detection: legacy (JSON blob) vs flat format
// ---------------------------------------------------------------------------

/** A row is legacy if it has a `metadata` property that's an object (not a string). */
export function isLegacyRow(row: any): row is ImportRow {
  return row && typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
}

// ---------------------------------------------------------------------------
// Legacy JSON-blob mapping (existing, unchanged)
// ---------------------------------------------------------------------------

export function mapRowToDocument(row: ImportRow): MappedDocument {
  const raw = row.metadata ?? {}
  const externalId = deriveExternalId(row.file_path)
  const { primary, all } = mapLanguages(raw['languages'])
  const JUNK_TITLES = new Set(['Pre-EM', 'Not available', '', undefined, null])
  const articleTitle = raw['Article Title'] as string | undefined
  const pubTitle = raw['Publication Title'] as string | undefined
  const title =
    (pubTitle && !JUNK_TITLES.has(pubTitle)) ? pubTitle
    : (articleTitle && !JUNK_TITLES.has(articleTitle)) ? articleTitle
    : externalId
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
    summary: row.summary ?? null,
    shortSummary: null,
    isFlat: false,
  }
}

// ---------------------------------------------------------------------------
// Flat CSV mapping (NEW)
// ---------------------------------------------------------------------------

// Legacy alias → DB column name
const LEGACY_ALIASES: Record<string, string> = {
  'Article Title': 'title',
  'Publication Title': 'publication_title',
  'All authors': 'authors',
  'YEAR published': 'year_published',
  'Date published': 'date_published',
  'short_summary': 'short_summary',
}

/** Resolve a flat row's column value, checking DB name first, then legacy aliases. */
function resolveField(row: FlatImportRow, dbName: string, ...aliases: string[]): string | undefined {
  if (row[dbName] !== undefined && row[dbName] !== '') return String(row[dbName])
  for (const alias of aliases) {
    if (row[alias] !== undefined && row[alias] !== '') return String(row[alias])
  }
  return undefined
}

export function mapFlatRowToDocument(row: FlatImportRow): MappedDocument {
  // external_id: explicit column > derived from file_path
  const externalId = resolveField(row, 'external_id') || (row.file_path ? deriveExternalId(row.file_path) : row.external_id || '')

  // file_path: required for s3_key, but for flat import without a file (metadata-only update),
  // we can construct it from external_id
  const filePath = row.file_path || (externalId ? `${externalId}.pdf` : '')
  const documentsS3Prefix = process.env.DOCUMENTS_S3_PREFIX || 'documents/'
  const base = filePath ? (filePath.split('/').pop() ?? filePath) : `${externalId}.pdf`
  const s3Key = `${documentsS3Prefix}${base}`

  const langRaw = resolveField(row, 'languages') || 'English'
  const { primary, all } = mapLanguages(langRaw)

  const title = resolveField(row, 'title', 'Article Title') || null
  const publicationTitle = resolveField(row, 'publication_title', 'Publication Title') || null
  const yearRaw = resolveField(row, 'year_published', 'YEAR published')
  const yearPublished = yearRaw ? parseYear(yearRaw) : null
  const doi = resolveField(row, 'doi') || null
  const articleType = resolveField(row, 'article_type') || null
  const wriPrimaryOffice = resolveField(row, 'wri_primary_office') || null
  const authors = resolveField(row, 'authors', 'All authors') || null
  const url = resolveField(row, 'url') || null
  const datePublishedRaw = resolveField(row, 'date_published', 'Date published')
  const datePublished = datePublishedRaw ? parseDatePublished(datePublishedRaw) : null
  const summary = resolveField(row, 'summary') || null
  const shortSummary = resolveField(row, 'short_summary') || null

  return {
    externalId,
    title,
    language: primary,
    languages: all,
    yearPublished,
    publicationTitle,
    s3Key,
    sourceMetadata: {
      file_path: filePath,
      summary: summary ?? '',
      metadata: {
        ...(title ? { 'Article Title': title } : {}),
        ...(publicationTitle ? { 'Publication Title': publicationTitle } : {}),
        ...(authors ? { 'All authors': authors } : {}),
        ...(yearRaw ? { 'YEAR published': yearRaw } : {}),
        ...(doi ? { 'DOI': doi } : {}),
        ...(articleType ? { 'article_type': articleType } : {}),
        ...(wriPrimaryOffice ? { 'wri_primary_office': wriPrimaryOffice } : {}),
        ...(url ? { 'URL': url } : {}),
        ...(datePublishedRaw ? { 'Date published': datePublishedRaw } : {}),
        ...(langRaw ? { 'languages': langRaw } : {}),
        ...(shortSummary ? { 'short_summary': shortSummary } : {}),
      },
    },
    doi,
    articleType,
    wriPrimaryOffice,
    authors,
    url,
    datePublished,
    summary,
    shortSummary,
    isFlat: true,
  }
}

/** Auto-detect legacy vs flat and map accordingly. */
export function mapAnyRowToDocument(row: AnyImportRow): MappedDocument {
  if (isLegacyRow(row)) {
    return mapRowToDocument(row)
  }
  return mapFlatRowToDocument(row as FlatImportRow)
}

// ---------------------------------------------------------------------------
// Matching: external_id OR doi
// ---------------------------------------------------------------------------

/** Find an existing document by external_id, or by doi if external_id doesn't match. */
async function findExistingDoc(
  mapped: MappedDocument,
): Promise<{ doc: Document; matchKey: string } | null> {
  const repo = AppDataSource.getRepository(Document)
  // Try external_id first
  let existing = await repo.findOne({ where: { externalId: mapped.externalId } })
  if (existing) return { doc: existing, matchKey: 'external_id' }
  // Try DOI (if the mapped row has a DOI and the existing doc has a matching DOI)
  if (mapped.doi) {
    existing = await repo.findOne({ where: { doi: mapped.doi } })
    if (existing) return { doc: existing, matchKey: 'doi' }
  }
  return null
}

// ---------------------------------------------------------------------------
// Seed semantics (legacy / fill-only-empty)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Overwrite semantics (flat format) — with warnings + human-field protection
// ---------------------------------------------------------------------------

// The metadata fields we can overwrite
const OVERWRITABLE_FIELDS = [
  'title',
  'language',
  'languages',
  'yearPublished',
  'publicationTitle',
  'doi',
  'articleType',
  'wriPrimaryOffice',
  'authors',
  'url',
  'datePublished',
] as const

type OverwritableField = (typeof OVERWRITABLE_FIELDS)[number]

/** Check if the metadata_source column exists in the documents table. */
async function metadataSourceExists(): Promise<boolean> {
  try {
    const [row] = await AppDataSource.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'metadata_source'`,
    )
    return !!row
  } catch {
    return false
  }
}

/** Read metadata_source for a doc (jsonb: {field: 'human'|'external'|'llm'}). */
async function readMetadataSource(docId: string): Promise<Record<string, string>> {
  try {
    const [row] = await AppDataSource.query(
      `SELECT metadata_source FROM documents WHERE id = $1`,
      [docId],
    )
    return row?.metadata_source ?? {}
  } catch {
    return {}
  }
}

/** Compute field changes for the overwrite preview (dry-run). */
export function computeOverwriteChanges(
  existing: Document,
  mapped: MappedDocument,
  metadataSource: Record<string, string> = {},
): { changes: FieldChange[]; warnings: string[] } {
  const changes: FieldChange[] = []
  const warnings: string[] = []

  for (const field of OVERWRITABLE_FIELDS) {
    const mappedValue = mapped[field] as string | string[] | number | null
    if (mappedValue === null || mappedValue === undefined) continue
    const mappedStr = Array.isArray(mappedValue) ? mappedValue.join(',') : String(mappedValue)
    const existingValue = existing[field] as string | string[] | number | null
    const existingStr = existingValue === null ? null : (Array.isArray(existingValue) ? existingValue.join(',') : String(existingValue))

    // Skip if values are the same
    if (existingStr === mappedStr) continue

    // Check metadata_source — protect human edits
    const sourceForField = metadataSource[field]
    if (sourceForField === 'human') {
      warnings.push(`protected: ${field} (human edit, not overwritten)`)
      changes.push({
        field,
        before: existingStr,
        after: mappedStr,
        overwrite: false,
        protected: true,
      })
      continue
    }

    const isOverwrite = existingStr !== null
    changes.push({
      field,
      before: existingStr,
      after: mappedStr,
      overwrite: isOverwrite,
      protected: false,
    })
    if (isOverwrite) {
      warnings.push(`⚠ ${field}: "${existingStr}" → "${mappedStr}" (overwrite)`)
    }
  }

  return { changes, warnings }
}

// ---------------------------------------------------------------------------
// Main import function — handles both legacy (seed) and flat (overwrite)
// ---------------------------------------------------------------------------

export async function importDocuments(
  rows: AnyImportRow[],
  options: { dryRun: boolean },
  identity?: AdminIdentity,
): Promise<ImportResult> {
  const docRepo = AppDataSource.getRepository(Document)
  const hasMetadataSource = await metadataSourceExists()

  const decisions: RowDecision[] = []
  let created = 0
  let updated = 0
  let skipped = 0
  let jobs = 0

  for (const row of rows) {
    // Validate file_path (if present)
    const filePath = (row as any).file_path
    if (filePath !== undefined && filePath !== null && filePath !== '') {
      if (typeof filePath !== 'string' || filePath.trim() === '') {
        decisions.push({ externalId: '', action: 'error', reason: 'invalid file_path' })
        continue
      }
      const validation = validateFilePath(filePath)
      if (!validation.ok) {
        decisions.push({ externalId: deriveExternalId(filePath), action: 'error', reason: validation.error })
        continue
      }
    } else if (!isLegacyRow(row)) {
      // Flat row with no file_path — OK if external_id or doi is provided (metadata-only update)
      const flatRow = row as FlatImportRow
      if (!flatRow.external_id && !flatRow.doi) {
        decisions.push({ externalId: '', action: 'error', reason: 'flat row must have file_path, external_id, or doi' })
        continue
      }
    } else {
      // Legacy row with no file_path
      decisions.push({ externalId: '', action: 'error', reason: 'invalid file_path' })
      continue
    }

    const mapped = mapAnyRowToDocument(row)

    // Match by external_id OR doi
    const match = await findExistingDoc(mapped)

    if (!match) {
      // --- CREATED ---
      decisions.push({
        externalId: mapped.externalId,
        action: 'created',
        matchKey: mapped.doi ? `doi:${mapped.doi}` : `external_id:${mapped.externalId}`,
      })

      if (!options.dryRun) {
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

        // Set metadata_source = 'external' for all written fields (graceful if column absent)
        if (hasMetadataSource && mapped.isFlat) {
          const fields: Record<string, string> = {}
          for (const f of OVERWRITABLE_FIELDS) {
            if (mapped[f] !== null && mapped[f] !== undefined) fields[f] = 'external'
          }
          await AppDataSource.query(
            `UPDATE documents SET metadata_source = $2::jsonb WHERE id = $1`,
            [saved.id, JSON.stringify(fields)],
          ).catch(() => {})
        }

        // Atomic job creation
        const [job] = await AppDataSource.query(
          `INSERT INTO ingestion_jobs (document_id, status) VALUES ($1, 'queued')
           ON CONFLICT (document_id) WHERE status IN ('queued', 'running') DO NOTHING
           RETURNING id`,
          [saved.id],
        )
        if (job) jobs++
        created++
      }
    } else {
      const { doc: existing, matchKey } = match

      if (mapped.isFlat) {
        // --- FLAT: OVERWRITE mode ---
        const metaSource = hasMetadataSource ? await readMetadataSource(existing.id) : {}
        const { changes, warnings } = computeOverwriteChanges(existing, mapped, metaSource)

        const hasRealChanges = changes.some((c) => !c.protected)
        if (hasRealChanges) {
          decisions.push({
            externalId: mapped.externalId || existing.externalId,
            action: 'updated',
            matchKey,
            changes,
            warnings,
          })

          if (!options.dryRun) {
            // Apply overwrites (skip protected fields)
            const updates: Partial<Document> & Record<string, any> = {}
            const metaUpdates: Record<string, string> = {}
            for (const c of changes) {
              if (c.protected) continue
              const field = c.field as any
              // Handle array fields (languages)
              if (field === 'languages') {
                updates[field] = mapped.languages
              } else {
                updates[field] = mapped[field as keyof MappedDocument] as any
              }
              metaUpdates[field] = 'external'
            }
            if (Object.keys(updates).length > 0) {
              // Always update sourceMetadata for flat imports
              updates.sourceMetadata = mapped.sourceMetadata
              await docRepo.update({ id: existing.id }, updates)

              // Update metadata_source
              if (hasMetadataSource) {
                const mergedMeta = { ...metaSource, ...metaUpdates }
                await AppDataSource.query(
                  `UPDATE documents SET metadata_source = $2::jsonb WHERE id = $1`,
                  [existing.id, JSON.stringify(mergedMeta)],
                ).catch(() => {})
              }
            }

            // Job creation (for updated docs, only if no open job)
            const [job] = await AppDataSource.query(
              `INSERT INTO ingestion_jobs (document_id, status) VALUES ($1, 'queued')
               ON CONFLICT (document_id) WHERE status IN ('queued', 'running') DO NOTHING
               RETURNING id`,
              [existing.id],
            )
            if (job) jobs++
            updated++
          }
        } else {
          decisions.push({
            externalId: mapped.externalId || existing.externalId,
            action: 'skipped',
            matchKey,
            changes,
            warnings: warnings.length > 0 ? warnings : undefined,
          })
          if (!options.dryRun) skipped++
        }
      } else {
        // --- LEGACY: fill-only-empty (SEED mode, existing behavior) ---
        const action = classifyUpsert(existing, mapped)
        decisions.push({ externalId: mapped.externalId, action })

        if (!options.dryRun) {
          if (action === 'updated') {
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
            await docRepo.update({ id: existing.id }, updates)
            updated++
          } else {
            skipped++
          }

          // Job creation
          const [job] = await AppDataSource.query(
            `INSERT INTO ingestion_jobs (document_id, status) VALUES ($1, 'queued')
             ON CONFLICT (document_id) WHERE status IN ('queued', 'running') DO NOTHING
             RETURNING id`,
            [existing.id],
          )
          if (job) jobs++
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

  // D5 fix: audit with the actor identity
  const actor = identity ? auditActor(identity) : { actorUserId: null, source: 'system' as const }
  await writeAudit({
    ...actor,
    action: 'import',
    entityType: 'documents',
    entityId: null,
    after: { created, updated, skipped, jobs },
  })

  return { created, updated, skipped, jobs }
}
