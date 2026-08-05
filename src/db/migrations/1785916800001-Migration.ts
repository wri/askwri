import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1785916800001 implements MigrationInterface {
  name = 'Migration1785916800001'

  public async up(q: QueryRunner): Promise<void> {
    // Issue #310: ingestion no longer auto-publishes, but a RE-ingested doc
    // that was already human-promoted must come back searchable, not be
    // silently unpublished (a full reingest_all would otherwise take down the
    // whole corpus). The parse stage records the document's pre-ingest status
    // here (first write per job wins); the publish stage reads it to decide
    // restore-vs-park. Written by the Python worker; nullable for old rows.
    await q.query(`
      ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS prior_status text`)
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE ingestion_jobs DROP COLUMN IF EXISTS prior_status`,
    )
  }
}
