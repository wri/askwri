import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1781330000000 implements MigrationInterface {
  name = 'Migration1781330000000'

  public async up(q: QueryRunner): Promise<void> {
    // Provenance tracking for metadata fields: maps field name -> 'external'|'llm'|'human'.
    // The parse stage reads this to decide whether to overwrite on re-ingest
    // (overwrite only if source is NULL or 'llm'; never touch 'external'/'human').
    await q.query(`ALTER TABLE "documents" ADD COLUMN "metadata_source" jsonb NOT NULL DEFAULT '{}'::jsonb`)

    // Backfill migrated docs (source_metadata IS NOT NULL): all fields came from the CSV → 'external'.
    await q.query(`
      UPDATE documents SET metadata_source = jsonb_build_object(
        'title', 'external', 'authors', 'external', 'doi', 'external',
        'year_published', 'external', 'publication_title', 'external',
        'article_type', 'external', 'wri_primary_office', 'external',
        'url', 'external'
      ) WHERE source_metadata IS NOT NULL
    `)

    // Backfill worker-ingested docs (source_metadata IS NULL, content_hash IS NOT NULL):
    // fields were worker-extracted → 'llm' for any non-NULL column.
    await q.query(`
      UPDATE documents SET metadata_source = metadata_source || jsonb_build_object(
        'title', CASE WHEN title IS NOT NULL THEN 'llm' END,
        'authors', CASE WHEN authors IS NOT NULL THEN 'llm' END,
        'doi', CASE WHEN doi IS NOT NULL THEN 'llm' END,
        'year_published', CASE WHEN year_published IS NOT NULL THEN 'llm' END,
        'article_type', CASE WHEN article_type IS NOT NULL THEN 'llm' END,
        'wri_primary_office', CASE WHEN wri_primary_office IS NOT NULL THEN 'llm' END
      ) WHERE source_metadata IS NULL AND content_hash IS NOT NULL
    `)
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "documents" DROP COLUMN IF EXISTS "metadata_source"`)
  }
}
