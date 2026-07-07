/**
 * @jest-environment node
 *
 * Tests for import-documents pure mappers + one DB integration test.
 * DB test is gated on process.env.DATABASE_URL — skipped cleanly if unset.
 */

import { NextRequest } from 'next/server'
import { POST as importDocumentsRoute } from '@/app/api/import-documents/route'
import {
  deriveExternalId,
  mapLanguages,
  parseYear,
  mapRowToDocument,
  mapFlatRowToDocument,
  isLegacyRow,
  computeOverwriteChanges,
  classifyUpsert,
  importDocuments,
  validateFilePath,
  ImportRow,
  FlatImportRow,
} from '@/db/queries/importDocuments'
import { AppDataSource } from '@/db/data-source'

// ---------------------------------------------------------------------------
// Pure mapper tests
// ---------------------------------------------------------------------------

describe('deriveExternalId', () => {
  it('strips .pdf extension', () => {
    expect(deriveExternalId('2021_report.pdf')).toBe('2021_report')
  })

  it('strips directory prefix', () => {
    expect(deriveExternalId('docs/sub/2021_report.pdf')).toBe('2021_report')
  })

  it('leaves non-.pdf paths unchanged', () => {
    expect(deriveExternalId('some_file')).toBe('some_file')
  })

  it('handles file with no directory', () => {
    expect(deriveExternalId('plain.pdf')).toBe('plain')
  })

  it('strips the extension case-insensitively (.PDF)', () => {
    expect(deriveExternalId('Report.PDF')).toBe('Report')
  })

  it('strips mixed-case extension (.Pdf) with directory prefix', () => {
    expect(deriveExternalId('docs/Report.Pdf')).toBe('Report')
  })
})

describe('mapLanguages', () => {
  it('maps english → en', () => {
    expect(mapLanguages('English')).toEqual({ primary: 'en', all: ['en'] })
  })

  it('maps spanish → es', () => {
    expect(mapLanguages('Spanish')).toEqual({ primary: 'es', all: ['es'] })
  })

  it('maps portuguese → pt', () => {
    expect(mapLanguages('Portuguese')).toEqual({ primary: 'pt', all: ['pt'] })
  })

  it('maps chinese → zh', () => {
    expect(mapLanguages('Chinese')).toEqual({ primary: 'zh', all: ['zh'] })
  })

  it('maps bahasa → id (Phase 1 amendment)', () => {
    expect(mapLanguages('Bahasa')).toEqual({ primary: 'id', all: ['id'] })
  })

  it('handles semicolon-separated list', () => {
    expect(mapLanguages('English; Spanish')).toEqual({
      primary: 'en',
      all: ['en', 'es'],
    })
  })

  it('handles comma-separated list', () => {
    expect(mapLanguages('English, Portuguese')).toEqual({
      primary: 'en',
      all: ['en', 'pt'],
    })
  })

  it('defaults to en for unknown language', () => {
    expect(mapLanguages('Klingon')).toEqual({ primary: 'en', all: ['en'] })
  })

  it('defaults to en for null input', () => {
    expect(mapLanguages(null)).toEqual({ primary: 'en', all: ['en'] })
  })

  it('defaults to en for empty string', () => {
    expect(mapLanguages('')).toEqual({ primary: 'en', all: ['en'] })
  })

  it('filters out unknown labels from a mixed list', () => {
    expect(mapLanguages('English; Klingon')).toEqual({
      primary: 'en',
      all: ['en'],
    })
  })

  it('is case-insensitive', () => {
    expect(mapLanguages('ENGLISH')).toEqual({ primary: 'en', all: ['en'] })
  })
})

describe('parseYear', () => {
  it('parses a plain integer year', () => {
    expect(parseYear(2021)).toBe(2021)
  })

  it('parses a year from a string', () => {
    expect(parseYear('2019')).toBe(2019)
  })

  it('takes first 4 characters', () => {
    expect(parseYear('2020-01-01')).toBe(2020)
  })

  it('returns null for NaN', () => {
    expect(parseYear('not-a-year')).toBeNull()
  })

  it('returns null for null', () => {
    expect(parseYear(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(parseYear(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseYear('')).toBeNull()
  })
})

describe('mapRowToDocument', () => {
  const baseRow: ImportRow = {
    file_path: 'docs/2021_report_abc.pdf',
    metadata: {
      'Article Title': 'My Report',
      'Publication Title': 'WRI Journal',
      languages: 'English',
      'YEAR published': '2021',
    },
    summary: 'A nice summary',
  }

  it('derives externalId from file_path', () => {
    const mapped = mapRowToDocument(baseRow)
    expect(mapped.externalId).toBe('2021_report_abc')
  })

  it('prefers Publication Title over Article Title (parity with migration _title)', () => {
    const mapped = mapRowToDocument(baseRow)
    expect(mapped.title).toBe('WRI Journal')
  })

  it('falls back to Article Title when Publication Title is absent', () => {
    const row: ImportRow = {
      ...baseRow,
      metadata: { ...baseRow.metadata, 'Publication Title': undefined as any },
    }
    const mapped = mapRowToDocument(row)
    expect(mapped.title).toBe('My Report')
  })

  it('prefers Publication Title when Article Title is a junk sentinel (Pre-EM / Not available) — G-1/F3-1 fix', () => {
    const row: ImportRow = {
      ...baseRow,
      metadata: { ...baseRow.metadata, 'Article Title': 'Pre-EM' },
    }
    const mapped = mapRowToDocument(row)
    expect(mapped.title).toBe('WRI Journal') // not 'Pre-EM'
  })

  it('falls back to externalId when both title fields are absent (script parity)', () => {
    const row: ImportRow = {
      ...baseRow,
      metadata: {
        ...baseRow.metadata,
        'Article Title': undefined as any,
        'Publication Title': undefined as any,
      },
    }
    const mapped = mapRowToDocument(row)
    expect(mapped.title).toBe('2021_report_abc')
  })

  it('source_metadata matches expected shape', () => {
    const mapped = mapRowToDocument(baseRow)
    expect(mapped.sourceMetadata).toEqual({
      file_path: 'docs/2021_report_abc.pdf',
      summary: 'A nice summary',
      metadata: baseRow.metadata,
    })
  })

  it('source_metadata.summary defaults to empty string when absent', () => {
    const row: ImportRow = { ...baseRow, summary: undefined }
    const mapped = mapRowToDocument(row)
    expect(mapped.sourceMetadata.summary).toBe('')
  })
})

describe('classifyUpsert', () => {
  const mapped = {
    externalId: 'test',
    title: 'Title',
    language: 'en',
    languages: ['en'],
    yearPublished: 2021,
    publicationTitle: 'Pub',
    s3Key: 'documents/test.pdf',
    sourceMetadata: {},
    doi: null,
    articleType: null,
    wriPrimaryOffice: null,
    authors: null,
    url: null,
    datePublished: null,
  }

  it('returns created when no existing doc', () => {
    expect(classifyUpsert(null, mapped)).toBe('created')
  })

  it('returns updated when title is null and mapped has title', () => {
    const existing = { title: null } as any
    expect(classifyUpsert(existing, mapped)).toBe('updated')
  })

  it('returns updated when yearPublished is null', () => {
    const existing = { title: 'X', language: 'en', languages: ['en'], yearPublished: null, publicationTitle: 'P', sourceMetadata: {} } as any
    expect(classifyUpsert(existing, mapped)).toBe('updated')
  })

  it('returns skipped when all non-null columns match', () => {
    const existing = {
      title: 'Some Title',
      language: 'en',
      languages: ['en'],
      yearPublished: 2020,
      publicationTitle: 'Pub',
      sourceMetadata: { file_path: 'x' },
      doi: '10.1234/x',
      articleType: 'WP',
      wriPrimaryOffice: 'WRI',
      authors: 'A',
      url: 'U',
      datePublished: '2020-01-01',
    } as any
    expect(classifyUpsert(existing, mapped)).toBe('skipped')
  })

  it('returns updated when doi is null and mapped has doi', () => {
    const existing = { title: 'X', language: 'en', languages: ['en'], yearPublished: 2020, publicationTitle: 'P', sourceMetadata: { file_path: 'x' }, doi: null, articleType: 'WP', wriPrimaryOffice: 'WRI', authors: 'A', url: 'U', datePublished: '2020-01-01' } as any
    expect(classifyUpsert(existing, { ...mapped, doi: '10.1234/x' })).toBe('updated')
  })

  it('returns updated when authors is null and mapped has authors', () => {
    const existing = { title: 'X', language: 'en', languages: ['en'], yearPublished: 2020, publicationTitle: 'P', sourceMetadata: { file_path: 'x' }, doi: 'D', articleType: 'WP', wriPrimaryOffice: 'WRI', authors: null, url: 'U', datePublished: '2020-01-01' } as any
    expect(classifyUpsert(existing, { ...mapped, authors: 'Smith, J.' })).toBe('updated')
  })
})

describe('mapRowToDocument — new column mapping', () => {
  const fullRow: ImportRow = {
    file_path: '2021_report_abc.pdf',
    metadata: {
      'Article Title': 'My Report',
      'Publication Title': 'WRI Journal',
      languages: 'English',
      'YEAR published': '2021',
      'DOI': 'https://doi.org/10.1234/test',
      'article_type': 'Working Paper',
      'wri_primary_office': 'WRI Global',
      'All authors': 'Smith, John; Doe, Jane',
      'URL': 'https://www.wri.org/research/test',
      'Date published': '8/17/2021',
    },
    summary: 'A nice summary',
  }

  it('maps DOI → doi', () => {
    expect(mapRowToDocument(fullRow).doi).toBe('https://doi.org/10.1234/test')
  })
  it('maps article_type → articleType', () => {
    expect(mapRowToDocument(fullRow).articleType).toBe('Working Paper')
  })
  it('maps wri_primary_office → wriPrimaryOffice', () => {
    expect(mapRowToDocument(fullRow).wriPrimaryOffice).toBe('WRI Global')
  })
  it('maps All authors → authors', () => {
    expect(mapRowToDocument(fullRow).authors).toBe('Smith, John; Doe, Jane')
  })
  it('maps URL → url', () => {
    expect(mapRowToDocument(fullRow).url).toBe('https://www.wri.org/research/test')
  })
  it('maps Date published → datePublished (ISO)', () => {
    expect(mapRowToDocument(fullRow).datePublished).toBe('2021-08-17')
  })
  it('s3Key is sanitized to documents/ prefix', () => {
    expect(mapRowToDocument(fullRow).s3Key).toBe('documents/2021_report_abc.pdf')
  })
  it('nulls missing optional fields', () => {
    const minimalRow: ImportRow = {
      file_path: 'minimal.pdf',
      metadata: { languages: 'English' },
      summary: '',
    }
    const m = mapRowToDocument(minimalRow)
    expect(m.doi).toBeNull()
    expect(m.articleType).toBeNull()
    expect(m.wriPrimaryOffice).toBeNull()
    expect(m.authors).toBeNull()
    expect(m.url).toBeNull()
    expect(m.datePublished).toBeNull()
  })
})

describe('validateFilePath', () => {
  it('accepts a bare .pdf basename', () => {
    expect(validateFilePath('2021_report.pdf')).toEqual({ ok: true, base: '2021_report.pdf' })
  })
  it('accepts under the documents prefix', () => {
    expect(validateFilePath('documents/foo.pdf')).toEqual({ ok: true, base: 'foo.pdf' })
  })
  it('rejects a non-.pdf file', () => {
    expect(validateFilePath('foo.txt').ok).toBe(false)
  })
  it('rejects path traversal (..)', () => {
    expect(validateFilePath('../etc/passwd.pdf').ok).toBe(false)
  })
  it('rejects a cross-prefix directory (eval-data/)', () => {
    expect(validateFilePath('eval-data/secret.pdf').ok).toBe(false)
  })
  it('rejects an empty string', () => {
    expect(validateFilePath('').ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Route auth (no DB needed: rejected before any DB access)
// ---------------------------------------------------------------------------

describe('POST /api/import-documents auth', () => {
  beforeAll(() => {
    process.env.ADMIN_API_TOKEN = 'test-admin-token'
  })

  function importReq(body: unknown, bearer?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (bearer) headers.authorization = `Bearer ${bearer}`
    return new NextRequest('http://localhost/api/import-documents', {
      method: 'POST',
      body: JSON.stringify(body),
      headers,
    })
  }

  it('401s without credentials', async () => {
    const res = await importDocumentsRoute(importReq({ rows: [] }))
    expect(res.status).toBe(401)
  })

  it('passes auth with the bearer token (then 400s on empty rows)', async () => {
    const res = await importDocumentsRoute(importReq({ rows: [] }, 'test-admin-token'))
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Flat CSV format tests (NEW)
// ---------------------------------------------------------------------------

describe('isLegacyRow', () => {
  it('returns true for legacy format (has metadata object)', () => {
    expect(isLegacyRow({ file_path: 'x.pdf', metadata: {}, summary: '' })).toBe(true)
  })
  it('returns false for flat format (no metadata object)', () => {
    expect(isLegacyRow({ file_path: 'x.pdf', title: 'T', doi: 'D' })).toBe(false)
  })
  it('returns false for a flat row with metadata as a string (not an object)', () => {
    expect(isLegacyRow({ file_path: 'x.pdf', metadata: 'not-an-object', title: 'T' })).toBe(false)
  })
})

describe('mapFlatRowToDocument', () => {
  it('maps DB column names directly', () => {
    const row: FlatImportRow = {
      file_path: 'report.pdf',
      external_id: 'report-2024',
      doi: 'https://doi.org/10.1234/test',
      title: 'My Report',
      authors: 'Smith, J.',
      year_published: '2024',
      publication_title: 'WRI Journal',
      article_type: 'Working Paper',
      wri_primary_office: 'WRI Global',
      languages: 'English',
      url: 'https://example.com',
      date_published: '3/15/2024',
      summary: 'A summary',
      short_summary: 'Short',
    }
    const m = mapFlatRowToDocument(row)
    expect(m.externalId).toBe('report-2024')
    expect(m.doi).toBe('https://doi.org/10.1234/test')
    expect(m.title).toBe('My Report')
    expect(m.authors).toBe('Smith, J.')
    expect(m.yearPublished).toBe(2024)
    expect(m.publicationTitle).toBe('WRI Journal')
    expect(m.articleType).toBe('Working Paper')
    expect(m.wriPrimaryOffice).toBe('WRI Global')
    expect(m.url).toBe('https://example.com')
    expect(m.datePublished).toBe('2024-03-15')
    expect(m.summary).toBe('A summary')
    expect(m.shortSummary).toBe('Short')
    expect(m.isFlat).toBe(true)
  })

  it('maps legacy alias column names', () => {
    const row: FlatImportRow = {
      file_path: 'old.pdf',
      'Article Title': 'Old Title',
      'All authors': 'Doe, J.',
      'YEAR published': '2020',
      'Date published': '1/5/2020',
      languages: 'Spanish',
    }
    const m = mapFlatRowToDocument(row)
    expect(m.title).toBe('Old Title')
    expect(m.authors).toBe('Doe, J.')
    expect(m.yearPublished).toBe(2020)
    expect(m.datePublished).toBe('2020-01-05')
    expect(m.language).toBe('es')
  })

  it('DB column names take priority over legacy aliases', () => {
    const row: FlatImportRow = {
      file_path: 'x.pdf',
      title: 'DB Title',
      'Article Title': 'Alias Title',
    }
    const m = mapFlatRowToDocument(row)
    expect(m.title).toBe('DB Title')
  })

  it('derives external_id from file_path when no external_id column', () => {
    const m = mapFlatRowToDocument({ file_path: '2024_report.pdf' })
    expect(m.externalId).toBe('2024_report')
  })

  it('uses explicit external_id when provided', () => {
    const m = mapFlatRowToDocument({ file_path: 'foo.pdf', external_id: 'custom-id' })
    expect(m.externalId).toBe('custom-id')
  })

  it('nulls missing optional fields', () => {
    const m = mapFlatRowToDocument({ file_path: 'bare.pdf' })
    expect(m.title).toBeNull()
    expect(m.doi).toBeNull()
    expect(m.authors).toBeNull()
    expect(m.url).toBeNull()
    expect(m.datePublished).toBeNull()
  })
})

describe('computeOverwriteChanges', () => {
  const existing = {
    title: 'Old Title',
    language: 'en',
    languages: ['en'],
    yearPublished: 2020,
    publicationTitle: 'Old Pub',
    doi: '10.1234/old',
    articleType: 'Report',
    wriPrimaryOffice: 'WRI',
    authors: 'Old Author',
    url: 'https://old.com',
    datePublished: '2020-01-01',
  } as any

  it('flags a title overwrite (non-null → new value)', () => {
    const mapped = { ...existing, title: 'New Title', isFlat: true } as any
    const { changes, warnings } = computeOverwriteChanges(existing, mapped)
    const titleChange = changes.find((c) => c.field === 'title')
    expect(titleChange).toBeDefined()
    expect(titleChange!.overwrite).toBe(true)
    expect(titleChange!.before).toBe('Old Title')
    expect(titleChange!.after).toBe('New Title')
    expect(warnings.some((w) => w.includes('title:') && w.includes('overwrite'))).toBe(true)
  })

  it('flags a new field (null → value) as non-overwrite', () => {
    const existingNull = { ...existing, authors: null } as any
    const mapped = { ...existingNull, authors: 'New Author', isFlat: true } as any
    const { changes } = computeOverwriteChanges(existingNull, mapped)
    const authorsChange = changes.find((c) => c.field === 'authors')
    expect(authorsChange!.overwrite).toBe(false)
  })

  it('protects a field whose metadata_source is human', () => {
    const mapped = { ...existing, title: 'New Title', isFlat: true } as any
    const { changes, warnings } = computeOverwriteChanges(existing, mapped, { title: 'human' })
    const titleChange = changes.find((c) => c.field === 'title')
    expect(titleChange!.protected).toBe(true)
    expect(titleChange!.overwrite).toBe(false)
    expect(warnings.some((w) => w.includes('protected'))).toBe(true)
  })

  it('skips fields with no change', () => {
    const mapped = { ...existing, isFlat: true } as any
    const { changes } = computeOverwriteChanges(existing, mapped)
    expect(changes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// DB integration test
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL

describe('importDocuments() DB integration', () => {
  if (!DATABASE_URL) {
    console.warn(
      '[import-documents.db.test] Skipping: DATABASE_URL not set.',
    )
    it.skip('requires DATABASE_URL', () => {})
    return
  }

  const PREFIX = 'test-import-'

  const testRows: ImportRow[] = [
    {
      file_path: `${PREFIX}doc-alpha.pdf`,
      metadata: {
        'Article Title': 'Alpha Document',
        'Publication Title': 'WRI Test Journal',
        languages: 'English',
        'YEAR published': '2022',
      },
      summary: 'Alpha summary',
    },
    {
      file_path: `${PREFIX}doc-beta.pdf`,
      metadata: {
        'Publication Title': 'Beta Journal',
        languages: 'Spanish',
        'YEAR published': '2023',
      },
      summary: 'Beta summary',
    },
  ]

  beforeAll(async () => {
    process.env.DATABASE_SSL = process.env.DATABASE_SSL ?? 'false'
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize()
    }
    // Clean up any leftover test data from previous runs
    await AppDataSource.query(
      `DELETE FROM ingestion_jobs WHERE document_id IN (SELECT id FROM documents WHERE external_id LIKE $1)`,
      [`${PREFIX}%`],
    )
    await AppDataSource.query(
      `DELETE FROM documents WHERE external_id LIKE $1`,
      [`${PREFIX}%`],
    )
  })

  afterAll(async () => {
    // Delete jobs first (FK), then documents
    await AppDataSource.query(
      `DELETE FROM ingestion_jobs WHERE document_id IN (SELECT id FROM documents WHERE external_id LIKE $1)`,
      [`${PREFIX}%`],
    )
    await AppDataSource.query(
      `DELETE FROM documents WHERE external_id LIKE $1`,
      [`${PREFIX}%`],
    )
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
  })

  it('creates 2 documents and 2 queued jobs', async () => {
    const result = await importDocuments(testRows, { dryRun: false })
    expect(result.created).toBe(2)
    expect(result.updated).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.jobs).toBe(2)

    // Verify documents exist in DB
    const docs = await AppDataSource.query(
      `SELECT external_id, status, title FROM documents WHERE external_id LIKE $1 ORDER BY external_id`,
      [`${PREFIX}%`],
    )
    expect(docs).toHaveLength(2)
    expect(docs[0].external_id).toBe(`${PREFIX}doc-alpha`)
    expect(docs[0].status).toBe('draft')
    expect(docs[0].title).toBe('WRI Test Journal') // Publication Title preferred over Article Title (parity with migration _title)
    expect(docs[1].external_id).toBe(`${PREFIX}doc-beta`)
    expect(docs[1].title).toBe('Beta Journal')

    // Verify queued jobs
    const jobsRows = await AppDataSource.query(
      `SELECT j.status FROM ingestion_jobs j
       JOIN documents d ON d.id = j.document_id
       WHERE d.external_id LIKE $1
       ORDER BY d.external_id`,
      [`${PREFIX}%`],
    )
    expect(jobsRows).toHaveLength(2)
    expect(jobsRows[0].status).toBe('queued')
    expect(jobsRows[1].status).toBe('queued')
  })

  it('skips re-import of same rows (idempotent)', async () => {
    const result = await importDocuments(testRows, { dryRun: false })
    expect(result.created).toBe(0)
    expect(result.updated).toBe(0)
    expect(result.skipped).toBe(2)
    expect(result.jobs).toBe(0) // no new jobs because open jobs exist
  })

  it('invalid file_path rows get a per-row error decision instead of throwing', async () => {
    const mixedRows: ImportRow[] = [
      { file_path: '', metadata: {}, summary: '' },
      { file_path: null as any, metadata: {}, summary: '' },
      {
        file_path: `${PREFIX}doc-delta.pdf`,
        metadata: { 'Article Title': 'Delta', languages: 'English', 'YEAR published': '2024' },
        summary: '',
      },
    ]
    const result = await importDocuments(mixedRows, { dryRun: true })
    expect(result.decisions).toHaveLength(3)
    expect(result.decisions![0]).toEqual({ externalId: '', action: 'error', reason: 'invalid file_path' })
    expect(result.decisions![1]).toEqual({ externalId: '', action: 'error', reason: 'invalid file_path' })
    expect(result.decisions![2].action).toBe('created')
  })

  it('dryRun returns decisions without writing', async () => {
    const freshRow: ImportRow[] = [
      {
        file_path: `${PREFIX}doc-gamma.pdf`,
        metadata: { 'Article Title': 'Gamma', languages: 'Portuguese', 'YEAR published': '2024' },
        summary: '',
      },
    ]
    const result = await importDocuments(freshRow, { dryRun: true })
    expect(result.decisions).toBeDefined()
    expect(result.decisions![0].action).toBe('created')
    // Should not have written to DB
    const rows = await AppDataSource.query(
      `SELECT id FROM documents WHERE external_id = $1`,
      [`${PREFIX}doc-gamma`],
    )
    expect(rows).toHaveLength(0)
  })
})
