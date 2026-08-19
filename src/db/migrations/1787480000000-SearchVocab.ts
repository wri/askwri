// src/db/migrations/1787480000000-SearchVocab.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

// Query-understanding P1 (docs/plans/2026-08-19-query-expansion-design.md):
// trigram did-you-mean vocabulary. Rows are PYTHON-OWNED (rebuilt by
// search-service/scripts/build_search_vocab.py, like keyword_vocab); this
// migration owns only the DDL. No TypeORM entity, matching document_chunks.
export class Migration1787480000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(`CREATE TABLE "search_vocab" (
      "term" text NOT NULL,
      "source" text NOT NULL,
      "df" integer NOT NULL DEFAULT 0,
      CONSTRAINT "PK_search_vocab" PRIMARY KEY ("term")
    )`);
    await queryRunner.query(
      `CREATE INDEX "idx_search_vocab_trgm" ON "search_vocab" USING gin ("term" gin_trgm_ops)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "search_vocab"`);
    // pg_trgm extension is left installed: shared infrastructure, dropping
    // it could break unrelated objects.
  }
}
