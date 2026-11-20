/**
 * Column order for metadata CSVs, shared by the two ends of the round trip:
 * the downloadable import template (/api/admin/import/template) and the catalog
 * export (/api/admin/documents/export). Consumers: mapFlatRowToDocument() reads
 * these names, so changing an entry here changes what the importer accepts.
 */
export const METADATA_CSV_COLUMNS = [
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
] as const
