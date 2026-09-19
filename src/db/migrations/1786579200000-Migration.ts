import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * document_relations: directed edges between documents (issue #325).
 * document_id = the translation/rendition; related_document_id = the original.
 * Lifecycle: suggested -> confirmed | rejected. Rejected rows persist as
 * don't-re-suggest memory. Only confirmed edges affect retrieval.
 */
export class Migration1786579200000 implements MigrationInterface {
  name = 'Migration1786579200000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "document_relations" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "related_document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "relation_type" text NOT NULL DEFAULT 'translation_of',
        "status" text NOT NULL DEFAULT 'suggested',
        "source" text NOT NULL,
        "confidence" numeric,
        "signals" jsonb NOT NULL DEFAULT '{}',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "reviewed_by" text,
        "reviewed_at" timestamptz,
        CONSTRAINT "CHK_document_relations_not_self" CHECK ("document_id" <> "related_document_id")
      )`)
    // One row per undirected pair: a reverse-direction duplicate is the same pair.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_document_relations_pair" ON "document_relations"
      (LEAST("document_id"::text, "related_document_id"::text),
       GREATEST("document_id"::text, "related_document_id"::text),
       "relation_type")`)
    // A translation has at most one confirmed original.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_document_relations_confirmed" ON "document_relations"
      ("document_id") WHERE "status" = 'confirmed' AND "relation_type" = 'translation_of'`)
    await queryRunner.query(`
      CREATE INDEX "idx_document_relations_status" ON "document_relations" ("status")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "document_relations"`)
  }
}
