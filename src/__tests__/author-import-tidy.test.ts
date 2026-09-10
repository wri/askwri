/**
 * @jest-environment node
 *
 * Tests for the CSV import authors tidying (issue #411). Node environment,
 * not jsdom: importing importDocuments transitively constructs the TypeORM
 * DataSource, whose pg driver only loads under node (same pattern as
 * import-documents.test.ts).
 */
import {
  mapFlatRowToDocument,
  mapRowToDocument,
  computeOverwriteChanges,
  type FlatImportRow,
} from '../db/queries/importDocuments'
import type { Document } from '../db/entities/Document.entity'

describe('import mapping tidies authors', () => {
  it('flat rows: comma spacing fixed, no flag', () => {
    const mapped = mapFlatRowToDocument({
      authors: 'Amos,Albert',
      file_path: 'x.pdf',
    })
    expect(mapped.authors).toBe('Amos, Albert')
    expect(mapped.authorsUnverified).toBe(false)
  })

  it('flat rows: comma-less value kept verbatim and flagged', () => {
    const mapped = mapFlatRowToDocument({
      authors: 'Anjali Mahendra',
      file_path: 'x.pdf',
    })
    expect(mapped.authors).toBe('Anjali Mahendra')
    expect(mapped.authorsUnverified).toBe(true)
  })

  it('legacy rows: column tidied; sourceMetadata keeps the raw archival blob', () => {
    const mapped = mapRowToDocument({
      file_path: 'x.pdf',
      metadata: { 'All authors': 'Anjali Mahendra; Amos,Albert' },
    })
    expect(mapped.authors).toBe('Anjali Mahendra; Amos, Albert')
    expect(mapped.authorsUnverified).toBe(true)
    // source_metadata is the raw import record for legacy rows — NOT tidied.
    expect(mapped.sourceMetadata.metadata['All authors']).toBe(
      'Anjali Mahendra; Amos,Albert',
    )
  })

  it('null authors stay null and unflagged', () => {
    const mapped = mapFlatRowToDocument({ file_path: 'x.pdf' } as FlatImportRow)
    expect(mapped.authors).toBeNull()
    expect(mapped.authorsUnverified).toBe(false)
  })
})

describe('computeOverwriteChanges flags unverified authors', () => {
  const existing = {
    authors: 'Old Author',
    title: 'T',
    language: 'en',
    languages: ['en'],
    yearPublished: 2020,
    publicationTitle: null,
    doi: null,
    articleType: null,
    wriPrimaryOffice: null,
    url: null,
    datePublished: null,
  } as unknown as Document

  it('warns when overwriting authors with an unverified value', () => {
    const mapped = mapFlatRowToDocument({
      authors: 'Anjali Mahendra',
      file_path: 'x.pdf',
    })
    const { warnings } = computeOverwriteChanges(existing, mapped, {})
    expect(warnings).toContain(
      '⚠ authors: "Old Author" → "Anjali Mahendra" (overwrite)',
    )
    expect(warnings).toContain(
      '⚠ authors: format unverified (name without comma)',
    )
  })

  it('does not warn on verified overwrites', () => {
    const mapped = mapFlatRowToDocument({
      authors: 'Amos, Albert',
      file_path: 'x.pdf',
    })
    const { warnings } = computeOverwriteChanges(existing, mapped, {})
    expect(warnings).not.toContain(
      '⚠ authors: format unverified (name without comma)',
    )
  })
})
