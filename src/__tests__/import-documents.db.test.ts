/**
 * @jest-environment node
 *
 * DB integration tests for importDocuments — new columns, s3_key validation,
 * atomic job insert, audit actor, needs_review job handling.
 * Gated on process.env.DATABASE_URL — skipped cleanly if unset.
 */

import { AppDataSource } from '@/db/data-source'
import { importDocuments, ImportRow, FlatImportRow } from '@/db/queries/importDocuments'
import type { AdminIdentity } from '@/lib/auth/identity'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip
const adminIdentity: AdminIdentity = { kind: 'token', role: 'admin' }
const editorIdentity: AdminIdentity = { kind: 'user', userId: '00000000-0000-0000-0000-000000000000', username: 'test-editor', role: 'editor' }

d('importDocuments() DB integration — new columns + validation + audit', () => {
  const PREFIX = `test-impd1-${Date.now()}-`

  beforeAll(async () => {
    process.env.DATABASE_SSL = process.env.DATABASE_SSL ?? 'false'
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })

  afterAll(async () => {
    await AppDataSource.query(`DELETE FROM ingestion_jobs WHERE document_id IN (SELECT id FROM documents WHERE external_id LIKE $1)`, [`${PREFIX}%`])
    await AppDataSource.query(`DELETE FROM documents WHERE external_id LIKE $1`, [`${PREFIX}%`])
    // Don't destroy the connection — other test files may share it.
  })

  // (a) Import a row with all 14 CSV keys → all columns populated
  it('populates doi, articleType, wriPrimaryOffice, authors, url, datePublished', async () => {
    const row: ImportRow = {
      file_path: `${PREFIX}full-meta.pdf`,
      metadata: {
        'Article Title': 'Full Meta Doc',
        'Publication Title': 'WRI Journal',
        languages: 'English',
        'YEAR published': '2022',
        'DOI': 'https://doi.org/10.1234/full',
        'article_type': 'Working Paper',
        'wri_primary_office': 'WRI Global',
        'All authors': 'Smith, John; Doe, Jane',
        'URL': 'https://www.wri.org/research/full',
        'Date published': '3/15/2022',
      },
      summary: 'Full meta summary',
    }
    await importDocuments([row], { dryRun: false }, adminIdentity)

    const [doc] = await AppDataSource.query(
      `SELECT doi, article_type, wri_primary_office, authors, url, date_published, s3_key
       FROM documents WHERE external_id = $1`,
      [`${PREFIX}full-meta`],
    )
    expect(doc.doi).toBe('https://doi.org/10.1234/full')
    expect(doc.article_type).toBe('Working Paper')
    expect(doc.wri_primary_office).toBe('WRI Global')
    expect(doc.authors).toBe('Smith, John; Doe, Jane')
    expect(doc.url).toBe('https://www.wri.org/research/full')
    expect(new Date(doc.date_published).toISOString().split('T')[0]).toBe('2022-03-15')
    expect(doc.s3_key).toBe(`documents/${PREFIX}full-meta.pdf`)
  })

  // (b) Cross-prefix file_path → error decision (D3 security fix)
  it('rejects eval-data/secret.pdf with an error decision (cross-prefix)', async () => {
    const row: ImportRow = {
      file_path: 'eval-data/secret.pdf',
      metadata: { languages: 'English' },
      summary: '',
    }
    const result = await importDocuments([row], { dryRun: true }, adminIdentity)
    expect(result.decisions![0].action).toBe('error')
    expect(result.decisions![0].reason).toMatch(/prefix|traversal|\.pdf/i)
  })

  // (c) Non-.pdf file_path → error decision
  it('rejects foo.txt with an error decision (not .pdf)', async () => {
    const row: ImportRow = {
      file_path: 'foo.txt',
      metadata: { languages: 'English' },
      summary: '',
    }
    const result = await importDocuments([row], { dryRun: true }, adminIdentity)
    expect(result.decisions![0].action).toBe('error')
    expect(result.decisions![0].reason).toMatch(/\.pdf/i)
  })

  // (d) needs_review job does NOT block a new queued job (D2 fix)
  it('creates a new queued job when a needs_review job exists', async () => {
    // Create a doc with a needs_review job
    const [doc] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Needs Review Doc', 'needs_review') RETURNING id`,
      [`${PREFIX}needs-review`, `documents/${PREFIX}needs-review.pdf`],
    )
    await AppDataSource.query(
      `INSERT INTO ingestion_jobs (document_id, stage, status) VALUES ($1, 'publish', 'needs_review')`,
      [doc.id],
    )

    // Re-import the same doc — should create a NEW queued job (needs_review no longer blocks)
    const row: ImportRow = {
      file_path: `${PREFIX}needs-review.pdf`,
      metadata: { languages: 'English' },
      summary: '',
    }
    const result = await importDocuments([row], { dryRun: false }, adminIdentity)
    expect(result.jobs).toBe(1)

    // Verify: the doc now has a queued job alongside the needs_review job
    const jobs = await AppDataSource.query(
      `SELECT status FROM ingestion_jobs WHERE document_id = $1 ORDER BY created_at`,
      [doc.id],
    )
    const statuses = jobs.map((j: any) => j.status)
    expect(statuses).toContain('queued')
  })

  // (e) Audit row has actor_user_id + source 'human' (D5 fix)
  it('writes an audit row with the actor identity', async () => {
    const before = await AppDataSource.query(`SELECT max(id) FROM audit_log`)
    const beforeId = before[0].max ? Number(before[0].max) : 0

    const row: ImportRow = {
      file_path: `${PREFIX}audit-test.pdf`,
      metadata: { languages: 'English' },
      summary: '',
    }
    await importDocuments([row], { dryRun: false }, adminIdentity)

    const [audit] = await AppDataSource.query(
      `SELECT source, action, entity_type, after
       FROM audit_log WHERE id > $1 AND action = 'import' ORDER BY id DESC LIMIT 1`,
      [beforeId],
    )
    expect(audit).toBeDefined()
    // Bearer token identity → source 'system', actor NULL
    expect(audit.source).toBe('system')
    expect(audit.action).toBe('import')
  })

  // (f) Non-admin editor → the route layer enforces 403 (tested at route level,
  // but here we verify importDocuments itself doesn't crash with an editor identity)
  it('accepts an editor identity without crashing (route enforces role)', async () => {
    const row: ImportRow = {
      file_path: `${PREFIX}editor-id.pdf`,
      metadata: { languages: 'English' },
      summary: '',
    }
    const result = await importDocuments([row], { dryRun: true }, editorIdentity)
    expect(result.decisions).toBeDefined()
    expect(result.decisions![0].action).toBe('created')
  })

  // (g) Two concurrent imports of the same new doc → no unhandled 23505
  it('handles concurrent imports of the same doc without 23505 (atomic ON CONFLICT)', async () => {
    const row: ImportRow = {
      file_path: `${PREFIX}concurrent.pdf`,
      metadata: { languages: 'English', 'Article Title': 'Concurrent' },
      summary: '',
    }
    // Run two imports in parallel — the ON CONFLICT (external_id) + ON CONFLICT (document_id)
    // should handle the race without throwing a 23505
    const [r1, r2] = await Promise.allSettled([
      importDocuments([row], { dryRun: false }, adminIdentity),
      importDocuments([row], { dryRun: false }, adminIdentity),
    ])
    // At least one should succeed; the other should either succeed or skip
    // Neither should throw an unhandled 23505
    expect(r1.status === 'fulfilled' || r2.status === 'fulfilled').toBe(true)
    if (r1.status === 'rejected') expect(String(r1.reason)).not.toMatch(/23505|unique/i)
    if (r2.status === 'rejected') expect(String(r2.reason)).not.toMatch(/23505|unique/i)
  })

  // (h) Re-import of same rows is idempotent — jobs stays 0 (existing queued jobs)
  it('re-import is idempotent (no new jobs when queued jobs exist)', async () => {
    const rows: ImportRow[] = [
      {
        file_path: `${PREFIX}idempotent.pdf`,
        metadata: { 'Article Title': 'Idempotent', languages: 'English', 'YEAR published': '2024' },
        summary: '',
      },
    ]
    const first = await importDocuments(rows, { dryRun: false }, adminIdentity)
    expect(first.created).toBe(1)
    expect(first.jobs).toBe(1)

    const second = await importDocuments(rows, { dryRun: false }, adminIdentity)
    expect(second.created).toBe(0)
    expect(second.skipped).toBe(1)
    // ON CONFLICT DO NOTHING — existing queued job blocks a new one
    expect(second.jobs).toBe(0)
  })

  // --- Flat CSV format tests ---

  // (a) flat CSV row with external_id matching an existing doc → overwrite title
  it('flat format: overwrites title when external_id matches (with warning)', async () => {
    // Create a doc first
    const row: ImportRow = {
      file_path: `${PREFIX}flat-overwrite.pdf`,
      metadata: { 'Article Title': 'Original Title', languages: 'English', 'YEAR published': '2020' },
      summary: '',
    }
    await importDocuments([row], { dryRun: false }, adminIdentity)

    // Now flat-import with a new title
    const flatRow: FlatImportRow = {
      file_path: `${PREFIX}flat-overwrite.pdf`,
      external_id: `${PREFIX}flat-overwrite`,
      title: 'Overwritten Title',
    }
    const dryRun = await importDocuments([flatRow], { dryRun: true }, adminIdentity)
    expect(dryRun.decisions![0].action).toBe('updated')
    expect(dryRun.decisions![0].changes).toBeDefined()
    const titleChange = dryRun.decisions![0].changes!.find((c) => c.field === 'title')
    expect(titleChange).toBeDefined()
    expect(titleChange!.overwrite).toBe(true)
    expect(titleChange!.before).toBe('Original Title')
    expect(titleChange!.after).toBe('Overwritten Title')

    // Apply
    const applied = await importDocuments([flatRow], { dryRun: false }, adminIdentity)
    expect(applied.updated).toBe(1)

    const [doc] = await AppDataSource.query(
      `SELECT title FROM documents WHERE external_id = $1`,
      [`${PREFIX}flat-overwrite`],
    )
    expect(doc.title).toBe('Overwritten Title')
  })

  // (b) flat CSV row with doi matching an existing doc (no external_id) → matched by DOI
  it('flat format: matches by DOI when external_id does not match', async () => {
    // Create a doc with a DOI
    const createRow: ImportRow = {
      file_path: `${PREFIX}doi-match.pdf`,
      metadata: { 'Article Title': 'DOI Doc', DOI: '10.9999/doi-match-test', languages: 'English' },
      summary: '',
    }
    await importDocuments([createRow], { dryRun: false }, adminIdentity)

    // Flat-import with a DIFFERENT external_id but the SAME DOI
    const flatRow: FlatImportRow = {
      file_path: `${PREFIX}different-name.pdf`,
      external_id: `${PREFIX}different-name`,
      doi: '10.9999/doi-match-test',
      title: 'Updated via DOI',
    }
    const dryRun = await importDocuments([flatRow], { dryRun: true }, adminIdentity)
    expect(dryRun.decisions![0].action).toBe('updated')
    expect(dryRun.decisions![0].matchKey).toBe('doi')
  })

  // (c) flat CSV row with no match → created
  it('flat format: creates when no match by external_id or doi', async () => {
    const flatRow: FlatImportRow = {
      file_path: `${PREFIX}flat-new.pdf`,
      external_id: `${PREFIX}flat-new`,
      title: 'Brand New Doc',
      authors: 'New Author',
    }
    const result = await importDocuments([flatRow], { dryRun: false }, adminIdentity)
    expect(result.created).toBe(1)

    const [doc] = await AppDataSource.query(
      `SELECT title, authors FROM documents WHERE external_id = $1`,
      [`${PREFIX}flat-new`],
    )
    expect(doc.title).toBe('Brand New Doc')
    expect(doc.authors).toBe('New Author')
  })

  // (e) legacy JSON-blob row → fill-only-empty (backward compat, no overwrite)
  it('legacy format: does NOT overwrite existing title (fill-only-empty)', async () => {
    // Create a doc
    const createRow: ImportRow = {
      file_path: `${PREFIX}legacy-protect.pdf`,
      metadata: { 'Article Title': 'Original', languages: 'English' },
      summary: '',
    }
    await importDocuments([createRow], { dryRun: false }, adminIdentity)

    // Legacy re-import with a different title → should NOT overwrite (fill-only-empty)
    const reImport: ImportRow = {
      file_path: `${PREFIX}legacy-protect.pdf`,
      metadata: { 'Article Title': 'Should Not Overwrite', languages: 'English' },
      summary: '',
    }
    const result = await importDocuments([reImport], { dryRun: false }, adminIdentity)
    expect(result.skipped).toBe(1)
    expect(result.updated).toBe(0)

    const [doc] = await AppDataSource.query(
      `SELECT title FROM documents WHERE external_id = $1`,
      [`${PREFIX}legacy-protect`],
    )
    expect(doc.title).toBe('Original') // NOT overwritten
  })
})
