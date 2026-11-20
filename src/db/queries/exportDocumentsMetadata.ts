import { AppDataSource } from '../data-source'
import { LANGUAGE_MAP } from './importDocuments'
import { METADATA_CSV_COLUMNS } from '../../lib/metadataCsv'

/**
 * Reverse of LANGUAGE_MAP: "en" -> "English". The importer only recognises
 * these labels, so an export always re-imports to the same codes.
 */
const LANGUAGE_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(LANGUAGE_MAP).map(([name, code]) => [
    code,
    name.charAt(0).toUpperCase() + name.slice(1),
  ]),
)

/** RFC 4180 quoting: only wrap when the value needs it. */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function formatLanguages(codes: string[] | null): string {
  if (!Array.isArray(codes) || codes.length === 0) return ''
  return codes.map((code) => LANGUAGE_NAMES[code] ?? code).join(', ')
}

// summary/short_summary: document_summaries is authoritative for English (same
// precedence as getCatalogItems.ts); source_metadata is the pre-DMS fallback.
// date_published is formatted M/D/YYYY because parseDatePublished() only
// accepts that shape, and as bare text to dodge timezone shifts.
const METADATA_SQL = `
  SELECT d.s3_key,
         d.external_id,
         d.doi,
         d.title,
         d.authors,
         d.year_published,
         d.publication_title,
         d.article_type,
         d.wri_primary_office,
         d.languages,
         d.url,
         to_char(d.date_published, 'FMMM/FMDD/YYYY') AS date_published,
         COALESCE(NULLIF(sl.text, ''), NULLIF(d.source_metadata->>'summary', '')) AS summary,
         COALESCE(NULLIF(ss.text, ''), NULLIF(d.source_metadata->'metadata'->>'short_summary', '')) AS short_summary
    FROM documents d
    LEFT JOIN document_summaries sl
      ON sl.document_id = d.id AND sl.language = 'en' AND sl.kind = 'long'
    LEFT JOIN document_summaries ss
      ON ss.document_id = d.id AND ss.language = 'en' AND ss.kind = 'short'
   ORDER BY d.external_id ASC
`

/** Every document in the catalog (any status) as import-template CSV. */
export async function exportDocumentsMetadataCsv(): Promise<string> {
  const rows: any[] = await AppDataSource.query(METADATA_SQL)
  const lines = [METADATA_CSV_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(
      [
        // the importer rebuilds s3_key from the basename, so export just that
        String(row.s3_key).replace(/^.*\//, ''),
        row.external_id,
        row.doi,
        row.title,
        row.authors,
        row.year_published,
        row.publication_title,
        row.article_type,
        row.wri_primary_office,
        formatLanguages(row.languages),
        row.url,
        row.date_published,
        row.summary,
        row.short_summary,
      ]
        .map(csvEscape)
        .join(','),
    )
  }
  return lines.join('\n') + '\n'
}
