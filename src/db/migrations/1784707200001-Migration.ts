import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Marks the CSV-sourced document columns 'external' so the ingestion worker
 * stops treating them as unowned.
 *
 * worker/stages/parse.py overwrites a field whenever
 * metadata_source->><field> is NULL or 'llm'. The cutover left metadata_source
 * empty on all 168 documents, so the first re-ingest of each document silently
 * replaced curated CSV values with PDF extractions.
 *
 * `title` is the field that matters: it is the only title the public catalog
 * renders — nothing outside the admin document editor reads title_en — so an
 * LLM-extracted native title would put untranslated Chinese, Spanish and
 * Portuguese titles on the site for the 33 non-English documents.
 *
 * Where a re-ingest has already overwritten a value ('llm' provenance), the
 * curated CSV value is restored alongside the provenance stamp; a value marked
 * 'human' is never touched. Deliberately excluded: title_en (summarize.py skips
 * 'external', so claiming it would permanently block translation) and
 * language/languages (detection beats the CSV's labels).
 */
export class Migration1784707200001 implements MigrationInterface {
  name = 'Migration1784707200001'

  // Restores the value migrate_csv_to_postgres.py's _title() would have chosen:
  // prefer Publication Title, fall back to Article Title, then external_id,
  // skipping the junk sentinels in both.
  private static readonly CSV_TITLE = `
    CASE
      WHEN coalesce(source_metadata->'metadata'->>'Publication Title','')
             NOT IN ('','Pre-EM','Not available')
        THEN source_metadata->'metadata'->>'Publication Title'
      WHEN coalesce(source_metadata->'metadata'->>'Article Title','')
             NOT IN ('','Pre-EM','Not available')
        THEN source_metadata->'metadata'->>'Article Title'
      ELSE external_id
    END`

  public async up(q: QueryRunner): Promise<void> {
    // Restore any curated value a re-ingest already replaced.
    await q.query(
      `UPDATE documents SET title = ${Migration1784707200001.CSV_TITLE}
       WHERE metadata_source->>'title' = 'llm'`,
    )
    await q.query(
      `UPDATE documents SET article_type = source_metadata->'metadata'->>'article_type'
       WHERE metadata_source->>'article_type' = 'llm'
         AND coalesce(source_metadata->'metadata'->>'article_type','') <> ''`,
    )
    await q.query(
      `UPDATE documents SET wri_primary_office = source_metadata->'metadata'->>'wri_primary_office'
       WHERE metadata_source->>'wri_primary_office' = 'llm'
         AND coalesce(source_metadata->'metadata'->>'wri_primary_office','') <> ''`,
    )
    await q.query(
      `UPDATE documents SET authors = source_metadata->'metadata'->>'All authors'
       WHERE metadata_source->>'authors' = 'llm'
         AND coalesce(source_metadata->'metadata'->>'All authors','') <> ''`,
    )
    await q.query(
      `UPDATE documents SET doi = source_metadata->'metadata'->>'DOI'
       WHERE metadata_source->>'doi' = 'llm'
         AND coalesce(source_metadata->'metadata'->>'DOI','') <> ''`,
    )

    // Claim the fields for the CSV. Guarded on the COLUMN rather than on the
    // CSV: claiming a field whose column is empty would stamp it 'external'
    // and stop parse.py ever populating it. 'human' is never overwritten.
    for (const column of [
      'title',
      'doi',
      'year_published',
      'article_type',
      'wri_primary_office',
      'authors',
      'url',
      'date_published',
    ]) {
      await q.query(
        `UPDATE documents
         SET metadata_source = metadata_source || jsonb_build_object('${column}', 'external')
         WHERE "${column}" IS NOT NULL
           AND coalesce(metadata_source->>'${column}', 'llm') = 'llm'`,
      )
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    // Release the claim only where this migration made it. Values are left as
    // they are: the restored CSV value is the correct one either way, and the
    // LLM extraction it replaced is not recoverable.
    for (const column of [
      'title',
      'doi',
      'year_published',
      'article_type',
      'wri_primary_office',
      'authors',
      'url',
      'date_published',
    ]) {
      await q.query(
        `UPDATE documents SET metadata_source = metadata_source - '${column}'
         WHERE metadata_source->>'${column}' = 'external'`,
      )
    }
  }
}
