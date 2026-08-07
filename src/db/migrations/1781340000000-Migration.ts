import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Normalize documents.metadata_source keys written by the pre-fix CSV import
 * (camelCase entity-property names) to the canonical snake_case column names
 * that the Python worker reads. Idempotent: only touches rows holding the
 * old key.
 */
const RENAMES: [string, string][] = [
  ['yearPublished', 'year_published'],
  ['publicationTitle', 'publication_title'],
  ['articleType', 'article_type'],
  ['wriPrimaryOffice', 'wri_primary_office'],
  ['datePublished', 'date_published'],
  ['titleEn', 'title_en'],
]

export class Migration1781340000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    for (const [from, to] of RENAMES) {
      await q.query(
        `UPDATE documents
         SET metadata_source = (metadata_source - $1) || jsonb_build_object($2::text, metadata_source -> $1)
         WHERE metadata_source ? $1`,
        [from, to],
      )
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const [from, to] of RENAMES) {
      await q.query(
        `UPDATE documents
         SET metadata_source = (metadata_source - $2) || jsonb_build_object($1::text, metadata_source -> $2)
         WHERE metadata_source ? $2`,
        [from, to],
      )
    }
  }
}
