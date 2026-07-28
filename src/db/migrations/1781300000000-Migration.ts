import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1781300000000 implements MigrationInterface {
  name = 'Migration1781300000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Clean any existing duplicate open jobs before the unique index lands
    // (keep a running job over a queued one, then the newest per document —
    // never delete a job that is mid-flight in favor of a queued duplicate).
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY document_id
                 ORDER BY (status = 'running') DESC, created_at DESC, id DESC
               ) AS rn
        FROM ingestion_jobs
        WHERE status IN ('queued', 'running') AND document_id IS NOT NULL
      )
      DELETE FROM ingestion_jobs
      WHERE id IN (SELECT id FROM ranked WHERE rn > 1)`)

    // At most one open (queued/running) job per document.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_jobs_one_open_per_doc"
      ON "ingestion_jobs" ("document_id")
      WHERE status IN ('queued', 'running')`)

    // Jobs are meaningless without their document: cascade instead of orphaning.
    await queryRunner.query(
      `ALTER TABLE "ingestion_jobs" DROP CONSTRAINT "ingestion_jobs_document_id_fkey"`,
    )
    await queryRunner.query(`
      ALTER TABLE "ingestion_jobs"
      ADD CONSTRAINT "ingestion_jobs_document_id_fkey"
      FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ingestion_jobs" DROP CONSTRAINT "ingestion_jobs_document_id_fkey"`,
    )
    await queryRunner.query(`
      ALTER TABLE "ingestion_jobs"
      ADD CONSTRAINT "ingestion_jobs_document_id_fkey"
      FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL`)
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ingestion_jobs_one_open_per_doc"`,
    )
  }
}
