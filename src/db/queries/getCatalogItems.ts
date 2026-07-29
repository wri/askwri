import { AppDataSource } from '../data-source'

export interface CatalogItem {
  file_id: string
  file_name: string
  external_file_id: string
  meta: Record<string, any>
}

/**
 * The document-management fields the research UI keys off. Carried alongside
 * the legacy CSV-shaped `meta.metadata` string rather than folded into it:
 * `source_metadata` is a frozen import artefact (stale `languages`, pre-#303
 * bilingual titles, no authors/summary for worker-ingested docs), while these
 * come from the `documents` columns the ingestion worker maintains.
 */
export interface CatalogDms {
  doc_id: string
  title: string | null
  title_en: string | null
  authors: string | null
  year_published: number | null
  date_published: string | null
  publication_title: string | null
  article_type: string | null
  wri_primary_office: string | null
  doi: string | null
  url: string | null
  language: string | null
  languages: string[] | null
  summary_en: string
  short_summary_en: string
}

export interface CatalogDocRow {
  external_id: string
  s3_key: string
  source_metadata: Record<string, any> | null
  title: string | null
  title_en: string | null
  authors: string | null
  url: string | null
  date_published: string | null
  language: string | null
  languages: string[] | null
  year_published: number | null
  publication_title: string | null
  article_type: string | null
  wri_primary_office: string | null
  doi: string | null
  summary_en: string | null
  short_summary_en: string | null
}

// Mirrors normalizeRow() in src/app/api/catalog/route.ts over the legacy CSV
// shape {file_path, metadata: <json string>, summary}: file_id is empty (the
// CSV had no file_id column), file_name is the file path, and meta carries the
// raw metadata JSON as a string, exactly as the CSV path produced it.
// `meta.dms` is additive — the CSV path simply never sets it.
export function mapDocumentToCatalogItem(doc: CatalogDocRow): CatalogItem {
  const src = doc.source_metadata ?? {}
  const filePath = src.file_path || doc.s3_key
  // English summaries: document_summaries is authoritative; the CSV fields are
  // only a fallback for rows the summarize stage has not reached.
  const summaryEn = doc.summary_en || src.summary || ''
  const shortSummaryEn =
    doc.short_summary_en || src.metadata?.short_summary || ''
  const dms: CatalogDms = {
    doc_id: doc.external_id,
    title: doc.title,
    title_en: doc.title_en,
    authors: doc.authors,
    year_published: doc.year_published,
    date_published: doc.date_published,
    publication_title: doc.publication_title,
    article_type: doc.article_type,
    wri_primary_office: doc.wri_primary_office,
    doi: doc.doi,
    url: doc.url,
    language: doc.language,
    languages: doc.languages,
    summary_en: summaryEn,
    short_summary_en: shortSummaryEn,
  }
  return {
    file_id: '',
    file_name: filePath,
    external_file_id: '',
    meta: {
      file_path: filePath,
      metadata: JSON.stringify(src.metadata ?? {}),
      summary: summaryEn,
      dms,
    },
  }
}

// document_summaries has no TypeORM entity (see CLAUDE.md write ownership), so
// the English summaries are joined in raw SQL the way documentsAdmin.ts does.
const CATALOG_SQL = `
  SELECT d.external_id, d.s3_key, d.source_metadata, d.title, d.title_en,
         d.authors, d.url, d.date_published, d.language, d.languages,
         d.year_published, d.publication_title, d.article_type,
         d.wri_primary_office, d.doi,
         s_long.text  AS summary_en,
         s_short.text AS short_summary_en
  FROM documents d
  LEFT JOIN document_summaries s_long
    ON s_long.document_id = d.id AND s_long.language = 'en' AND s_long.kind = 'long'
  LEFT JOIN document_summaries s_short
    ON s_short.document_id = d.id AND s_short.language = 'en' AND s_short.kind = 'short'
  WHERE d.status = 'searchable'
  ORDER BY d.external_id ASC
`

export async function getCatalogItems(): Promise<CatalogItem[]> {
  const rows: CatalogDocRow[] = await AppDataSource.query(CATALOG_SQL)
  return rows.map(mapDocumentToCatalogItem)
}
