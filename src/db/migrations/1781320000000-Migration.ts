import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1781320000000 implements MigrationInterface {
  name = 'Migration1781320000000'

  public async up(q: QueryRunner): Promise<void> {
    // Drop the dead abstract column (0/170 populated, no reader anywhere —
    // exhaustively verified across app/Python/eval/terraform). The design
    // (§7.2) intended it from GROBID; GROBID was dropped (§9) with no
    // replacement writer. Re-adding later is a trivial additive migration if
    // a parser ever needs it.
    await q.query(`ALTER TABLE "documents" DROP COLUMN IF EXISTS "abstract"`)

    // Add editable metadata columns (CSV keys "All authors" / "URL" / "Date published").
    // Design §20 chose fixed columns as the interim for non-categorical metadata
    // (the deferred document_attributes table is a future fold-in).
    await q.query(`ALTER TABLE "documents" ADD COLUMN "authors" text`)
    await q.query(`ALTER TABLE "documents" ADD COLUMN "url" text`)
    await q.query(`ALTER TABLE "documents" ADD COLUMN "date_published" date`)

    // Backfill from source_metadata.metadata jsonb for migrated docs (169 rows).
    await q.query(
      `UPDATE documents SET authors = source_metadata->'metadata'->>'All authors'
       WHERE authors IS NULL AND source_metadata->'metadata'->>'All authors' IS NOT NULL`,
    )
    await q.query(
      `UPDATE documents SET url = source_metadata->'metadata'->>'URL'
       WHERE url IS NULL AND source_metadata->'metadata'->>'URL' IS NOT NULL`,
    )
    await q.query(
      `UPDATE documents SET date_published = to_date(source_metadata->'metadata'->>'Date published', 'MM/DD/YYYY')
       WHERE date_published IS NULL AND source_metadata->'metadata'->>'Date published' IS NOT NULL`,
    )

    // Fix 37 garbage titles: the migration's fallback chain picked a non-empty
    // junk "Article Title" ("Pre-EM" x34, "Not available" x3) and never reached
    // the good "Publication Title". Prefer Publication Title when the current
    // title is a junk sentinel and Publication Title is a real value.
    await q.query(
      `UPDATE documents SET title = source_metadata->'metadata'->>'Publication Title'
       WHERE title IN ('Pre-EM','Not available')
         AND source_metadata->'metadata'->>'Publication Title' IS NOT NULL
         AND source_metadata->'metadata'->>'Publication Title' NOT IN ('Pre-EM','Not available')`,
    )
    // Any still-junk title with no salvageable Publication Title → external_id
    // (cleaner than leaving "Pre-EM" as the displayed title).
    await q.query(
      `UPDATE documents SET title = external_id WHERE title IN ('Pre-EM','Not available')`,
    )

    // Relabel the 33 mislabeled summaries. Their text is English (langdetect
    // confirmed: all 33 stored=zh/es/pt but detected=en) but they were tagged
    // with the doc's primary language. Relabel → 'en' so they are correctly the
    // English rendition (design §7.5). This empties the native slots so the
    // worker's summarize stage regenerates real native-language summaries on
    // the next re-ingest (it skips occupied slots — relabel frees them).
    await q.query(
      `UPDATE document_summaries SET language = 'en' WHERE language IN ('zh','es','pt')`,
    )

    // Backfill title_en for the 33 non-English migrated docs (design §6:
    // "title_en always populated"). True translation is deferred (§10.4);
    // COALESCE to the native title is the documented interim.
    await q.query(
      `UPDATE documents SET title_en = title WHERE title_en IS NULL AND language <> 'en'`,
    )

    // Dedup: unique partial index on content_hash so two documents can never
    // share a content hash (the S3 intake dedup is application-level read-then-
    // insert; this enforces it at the DB level). NULLs allowed (migrated docs
    // have no hash yet).
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_documents_content_hash"
       ON "documents" ("content_hash") WHERE "content_hash" IS NOT NULL`,
    )
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_documents_content_hash"`)
    // Best-effort relabel back to native (cannot fully reverse without the
    // original native text, which was English — this is a one-way data fix).
    await q.query(
      `UPDATE document_summaries SET language = d.language
       FROM documents d
       WHERE document_summaries.document_id = d.id AND d.language IN ('zh','es','pt')`,
    )
    await q.query(
      `ALTER TABLE "documents" DROP COLUMN IF EXISTS "date_published"`,
    )
    await q.query(`ALTER TABLE "documents" DROP COLUMN IF EXISTS "url"`)
    await q.query(`ALTER TABLE "documents" DROP COLUMN IF EXISTS "authors"`)
    await q.query(`ALTER TABLE "documents" ADD COLUMN "abstract" text`)
  }
}
