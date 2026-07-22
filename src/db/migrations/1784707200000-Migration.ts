import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Repairs the QA cutover of 2026-07-21.
 *
 * Migration 1781320000000 carries the same backfills, but phase0-cutover.md
 * runs Step 2 (migrations) before Step 3 (the corpus load), so every one of
 * its UPDATEs matched zero rows — `documents` was still empty. The corpus then
 * arrived carrying exactly the defects that migration existed to repair:
 * 168 documents with no authors/url/date_published, 33 with no title_en, and
 * 66 summary rows filed under the wrong language.
 *
 * This migration re-applies those repairs against the loaded corpus, and adds
 * the s3_key prefix fix. Every statement is guarded so it is a no-op where the
 * data is already correct — safe to run against an environment that cut over
 * cleanly (which prod will, now that migrate_csv_to_postgres.py writes both
 * s3_key and the summary language correctly at insert time).
 */
export class Migration1784707200000 implements MigrationInterface {
  name = 'Migration1784707200000'

  public async up(q: QueryRunner): Promise<void> {
    // s3_key must carry the documents/ prefix. Readers use it verbatim —
    // worker/stages/parse.py and the PDF routes call get_object(Key=s3_key) —
    // and the ECS task role only grants s3:GetObject on <bucket>/documents/*.
    // A bare filename points at a nonexistent object at the bucket root, which
    // S3 reports as AccessDenied rather than NoSuchKey because the role's
    // s3:ListBucket grant is conditioned on s3:prefix. This broke re-ingest for
    // every migrated document.
    await q.query(
      `UPDATE documents SET s3_key = 'documents/' || s3_key WHERE s3_key NOT LIKE '%/%'`,
    )

    // Backfill the editable metadata columns from source_metadata (the CSV).
    await q.query(
      `UPDATE documents SET authors = source_metadata->'metadata'->>'All authors'
       WHERE authors IS NULL AND source_metadata->'metadata'->>'All authors' IS NOT NULL`,
    )
    await q.query(
      `UPDATE documents SET url = source_metadata->'metadata'->>'URL'
       WHERE url IS NULL AND source_metadata->'metadata'->>'URL' IS NOT NULL
         AND source_metadata->'metadata'->>'URL' <> ''`,
    )
    await q.query(
      `UPDATE documents SET date_published = to_date(source_metadata->'metadata'->>'Date published', 'MM/DD/YYYY')
       WHERE date_published IS NULL AND source_metadata->'metadata'->>'Date published' IS NOT NULL
         AND source_metadata->'metadata'->>'Date published' <> ''`,
    )

    // Mark those three as CSV-sourced. Without this, metadata_source->>'authors'
    // is NULL, which worker/stages/parse.py reads as "unowned" and overwrites
    // with its own LLM extraction from the PDF on the first re-ingest — losing
    // the curated author list. 'external' is protected from AI overwrite but
    // still replaceable by a future CSV import (see lib/metadataProvenance.ts).
    for (const column of ['authors', 'url', 'date_published']) {
      await q.query(
        `UPDATE documents
         SET metadata_source = metadata_source || jsonb_build_object('${column}', 'external')
         WHERE "${column}" IS NOT NULL AND metadata_source->>'${column}' IS NULL`,
      )
    }

    // The imported summaries are English for every document, including the
    // non-English ones. Filed under the document's own language they park
    // English prose in the native slot, where worker/stages/summarize.py can
    // never replace it (source='external' is protected), while leaving the
    // 'en' slot empty. Relabelling both corrects the English rendition and
    // frees the native slot for the summarize stage to fill on re-ingest.
    //
    // Guarded against the (document_id, language, kind) primary key: a row is
    // left alone if a genuine 'en' summary of the same kind already exists.
    await q.query(
      `UPDATE document_summaries AS s SET language = 'en'
       WHERE s.language <> 'en' AND s.source = 'external'
         AND NOT EXISTS (
           SELECT 1 FROM document_summaries e
           WHERE e.document_id = s.document_id AND e.language = 'en' AND e.kind = s.kind
         )`,
    )

    // Interim title_en for non-English documents (design §6: "title_en always
    // populated"). Deliberately does NOT set metadata_source->>'title_en':
    // summarize.py overwrites title_en unless provenance is 'human' or
    // 'external', so leaving it unset lets re-ingest replace this native-title
    // placeholder with a real translation.
    await q.query(
      `UPDATE documents SET title_en = title WHERE title_en IS NULL AND language <> 'en'`,
    )
  }

  public async down(q: QueryRunner): Promise<void> {
    // Reverses the summary relabel: the only external 'en' rows on a
    // non-English document are the ones up() moved there (the summarize stage
    // writes source='generated').
    //
    // Mirrors up()'s primary-key guard. A document can legitimately hold both a
    // genuine 'en' summary and a native-language one of the same kind — up()
    // skips those, so down() must not relabel an 'en' row back onto an
    // occupied native slot.
    await q.query(
      `UPDATE document_summaries AS s SET language = d.language
       FROM documents d
       WHERE s.document_id = d.id AND s.language = 'en' AND s.source = 'external'
         AND d.language <> 'en'
         AND NOT EXISTS (
           SELECT 1 FROM document_summaries n
           WHERE n.document_id = s.document_id AND n.language = d.language AND n.kind = s.kind
         )`,
    )
    await q.query(
      `UPDATE documents SET title_en = NULL
       WHERE language <> 'en' AND title_en = title AND metadata_source->>'title_en' IS NULL`,
    )
    // Only clear values this migration wrote: provenance is still 'external'
    // AND the column still equals the CSV value it was backfilled from. A value
    // since edited by a person, or written by importDocuments.ts for some other
    // document, is left untouched.
    await q.query(
      `UPDATE documents SET authors = NULL
       WHERE metadata_source->>'authors' = 'external'
         AND authors = source_metadata->'metadata'->>'All authors'`,
    )
    await q.query(
      `UPDATE documents SET url = NULL
       WHERE metadata_source->>'url' = 'external'
         AND url = source_metadata->'metadata'->>'URL'`,
    )
    await q.query(
      `UPDATE documents SET date_published = NULL
       WHERE metadata_source->>'date_published' = 'external'
         AND date_published = to_date(source_metadata->'metadata'->>'Date published', 'MM/DD/YYYY')`,
    )
    for (const column of ['authors', 'url', 'date_published']) {
      await q.query(
        `UPDATE documents SET metadata_source = metadata_source - '${column}'
         WHERE metadata_source->>'${column}' = 'external' AND "${column}" IS NULL`,
      )
    }
    // s3_key is deliberately NOT reverted: rows written correctly by
    // importDocuments.ts are indistinguishable from rows this migration fixed,
    // and stripping the prefix would break document retrieval for both.
  }
}
