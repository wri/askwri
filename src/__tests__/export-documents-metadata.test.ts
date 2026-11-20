/**
 * @jest-environment node
 *
 * Pure-function tests for the catalog metadata export. The DB path is covered
 * by verifying the endpoint end-to-end; what needs guarding here is the format
 * contract with /admin/import — a changed language label or escaping bug would
 * silently corrupt a round trip.
 */

import {
  csvEscape,
  formatLanguages,
} from '@/db/queries/exportDocumentsMetadata'
import { LANGUAGE_MAP, mapLanguages } from '@/db/queries/importDocuments'
import { METADATA_CSV_COLUMNS } from '@/lib/metadataCsv'

describe('formatLanguages', () => {
  it('uses the exact labels the importer maps back to the same codes', () => {
    for (const [name, code] of Object.entries(LANGUAGE_MAP)) {
      const label = formatLanguages([code])
      expect(label).toBe(name.charAt(0).toUpperCase() + name.slice(1))
      expect(mapLanguages(label).all).toEqual([code])
    }
  })

  it('joins multiple languages the way the template does', () => {
    expect(formatLanguages(['en', 'es'])).toBe('English, Spanish')
  })

  it('passes an unrecognised code through instead of dropping it', () => {
    expect(formatLanguages(['fr'])).toBe('fr')
  })

  it('handles empty and null', () => {
    expect(formatLanguages(null)).toBe('')
    expect(formatLanguages([])).toBe('')
  })
})

describe('csvEscape', () => {
  it('leaves plain values alone', () => {
    expect(csvEscape('Working Paper')).toBe('Working Paper')
  })

  it('quotes commas, quotes and newlines', () => {
    expect(csvEscape('Smith, John; Doe, Jane')).toBe('"Smith, John; Doe, Jane"')
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
  })

  it('renders null and undefined as empty', () => {
    expect(csvEscape(null)).toBe('')
    expect(csvEscape(undefined)).toBe('')
  })

  it('stringifies numbers', () => {
    expect(csvEscape(2021)).toBe('2021')
  })
})

describe('column contract', () => {
  it('matches the columns the import page documents', () => {
    expect(METADATA_CSV_COLUMNS).toEqual([
      'file_path',
      'external_id',
      'doi',
      'title',
      'authors',
      'year_published',
      'publication_title',
      'article_type',
      'wri_primary_office',
      'languages',
      'url',
      'date_published',
      'summary',
      'short_summary',
    ])
  })
})
