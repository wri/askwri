/**
 * Single source of truth for documents.metadata_source key naming.
 *
 * metadata_source is a jsonb map { <snake_case column>: 'human'|'external'|'llm' }.
 * The Python worker (worker/stages/parse.py) reads/writes snake_case column
 * names; all Node writers/readers MUST use the same keys via this map.
 * Pure module — safe to import from both server (db/queries) and client (admin UI).
 */
export const PROVENANCE_KEY: Record<string, string> = {
  title: 'title',
  titleEn: 'title_en',
  doi: 'doi',
  language: 'language',
  languages: 'languages',
  yearPublished: 'year_published',
  publicationTitle: 'publication_title',
  articleType: 'article_type',
  wriPrimaryOffice: 'wri_primary_office',
  authors: 'authors',
  url: 'url',
  datePublished: 'date_published',
}

export const PROVENANCE_LABEL: Record<string, string> = {
  human: 'Edited by a person — protected; never overwritten by imports or AI',
  external:
    'Imported from CSV — protected from AI overwrite; a new CSV import can change it',
  llm: 'AI-extracted from the PDF — may be refreshed on re-ingest',
}
