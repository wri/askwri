import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1785950560000 implements MigrationInterface {
  name = 'Migration1785950560000'

  public async up(q: QueryRunner): Promise<void> {
    // Parse cache (issue #310 follow-up, Fix 1): re-ingest currently re-runs
    // the OCR call even when the PDF bytes and the parser are unchanged, which
    // is the slowest and costliest stage of a prompt-tuning re-ingest campaign.
    // These three stamps record what produced the stored text; the parse stage
    // reuses the row (skipping download + OCR) only when all three match the
    // document's current content_hash and the worker's current backend/model.
    //
    // Behavior-neutral by construction: every pre-existing row has NULL stamps
    // and therefore always misses. Making an EXISTING corpus cache-eligible is
    // a separate per-environment ops step (the correct parse_backend value
    // differs by environment) — see docs/plans/2026-08-05-ocr-cache-shrink-batch.md.
    //
    // Written by the Python worker (document_texts is Python-owned).
    await q.query(`
      ALTER TABLE document_texts
        ADD COLUMN IF NOT EXISTS parsed_content_hash text,
        ADD COLUMN IF NOT EXISTS parse_backend text,
        ADD COLUMN IF NOT EXISTS parse_model text`)
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE document_texts
        DROP COLUMN IF EXISTS parsed_content_hash,
        DROP COLUMN IF EXISTS parse_backend,
        DROP COLUMN IF EXISTS parse_model`)
  }
}
