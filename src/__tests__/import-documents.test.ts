/**
 * @jest-environment node
 *
 * Tests for import-documents pure mappers + one DB integration test.
 * DB test is gated on process.env.DATABASE_URL — skipped cleanly if unset.
 */

import {
  deriveExternalId,
  mapLanguages,
  parseYear,
  mapRowToDocument,
  classifyUpsert,
  importDocuments,
  ImportRow,
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

  it('prefers Article Title over Publication Title', () => {
    const mapped = mapRowToDocument(baseRow)
    expect(mapped.title).toBe('My Report')
  })

  it('falls back to Publication Title when Article Title is absent', () => {
    const row: ImportRow = {
      ...baseRow,
      metadata: { ...baseRow.metadata, 'Article Title': undefined as any },
    }
    const mapped = mapRowToDocument(row)
    expect(mapped.title).toBe('WRI Journal')
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
    s3Key: 'test.pdf',
    sourceMetadata: {},
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
    } as any
    expect(classifyUpsert(existing, mapped)).toBe('skipped')
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
    expect(docs[0].title).toBe('Alpha Document')
    expect(docs[1].external_id).toBe(`${PREFIX}doc-beta`)
    expect(docs[1].title).toBe('Beta Journal') // falls back to Publication Title

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
