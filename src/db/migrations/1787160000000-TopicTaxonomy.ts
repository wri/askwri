import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Issue #323: topic taxonomy management + auto-tagging.
 * - Extend tags: parent_tag_id (self-ref tree), description, needs_reembed.
 * - tag_aliases: synonyms per tag (app-owned).
 * - tag_embeddings: pgvector, python-owned (NO TypeORM entity — mirrors
 *   document_chunks). Same model (cohere-embed-v4, 1536) as doc chunks.
 * - reclassify_jobs: classify-only re-run queue (separate from ingestion_jobs).
 *   Includes run_id so a single enqueue's jobs group into one "run" for the
 *   status panel (spec §6.4: per-run doc count + cost).
 */
export class Migration1787160000000 implements MigrationInterface {
  name = 'Migration1787160000000'

  public async up(q: QueryRunner): Promise<void> {
    // -- Extend tags (app-owned): 3 new columns + 2 indexes
    await q.query(`
      ALTER TABLE "tags"
        ADD COLUMN "parent_tag_id" uuid REFERENCES "tags"("id") ON DELETE SET NULL,
        ADD COLUMN "description" text,
        ADD COLUMN "needs_reembed" boolean NOT NULL DEFAULT false`)
    await q.query(`CREATE INDEX "idx_tags_parent" ON "tags" ("parent_tag_id")`)
    await q.query(`
      CREATE INDEX "idx_tags_facet_needs_reembed"
        ON "tags" ("facet") WHERE "needs_reembed" = true`)

    // -- tag_aliases (app-owned): synonyms per tag
    await q.query(`
      CREATE TABLE "tag_aliases" (
        "tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
        "alias" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tag_aliases" PRIMARY KEY ("tag_id", "alias")
      )`)
    await q.query(
      `CREATE INDEX "idx_tag_aliases_alias" ON "tag_aliases" ("alias")`,
    )

    // -- tag_embeddings (python-owned, pgvector, NO TypeORM entity)
    //    Mirrors document_chunks: per-row embedding_model/dimension,
    //    HNSW index scoped by model with fixed vector(1536) cast.
    await q.query(`
      CREATE TABLE "tag_embeddings" (
        "tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
        "embedding_model" text NOT NULL,
        "dimension" integer NOT NULL,
        "embedding" vector NOT NULL,
        "embedded_text" text,
        "embedded_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tag_embeddings" PRIMARY KEY ("tag_id", "embedding_model")
      )`)
    await q.query(`
      CREATE INDEX "idx_tag_embeddings_hnsw" ON "tag_embeddings"
        USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
        WHERE embedding_model = 'cohere-embed-v4'`)

    // -- reclassify_jobs (app-owned): classify-only re-run queue
    //    run_id groups jobs from a single enqueue into one "run" for the
    //    status panel (spec §6.4).
    await q.query(`
      CREATE TABLE "reclassify_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "scope_tag_id" uuid REFERENCES "tags"("id") ON DELETE SET NULL,
        "run_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "status" text NOT NULL DEFAULT 'queued',
        "attempts" integer NOT NULL DEFAULT 0,
        "error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reclassify_jobs" PRIMARY KEY ("id")
      )`)
    await q.query(`
      CREATE UNIQUE INDEX "reclassify_jobs_one_open_per_doc"
        ON "reclassify_jobs" ("document_id") WHERE "status" IN ('queued','running')`)
    await q.query(`
      CREATE INDEX "idx_reclassify_jobs_claim"
        ON "reclassify_jobs" ("status", "created_at")`)
    await q.query(`
      CREATE INDEX "idx_reclassify_jobs_run"
        ON "reclassify_jobs" ("run_id", "created_at")`)
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "reclassify_jobs"`)
    await q.query(`DROP TABLE IF EXISTS "tag_embeddings"`)
    await q.query(`DROP TABLE IF EXISTS "tag_aliases"`)
    await q.query(`DROP INDEX IF EXISTS "idx_tags_facet_needs_reembed"`)
    await q.query(`DROP INDEX IF EXISTS "idx_tags_parent"`)
    await q.query(`
      ALTER TABLE "tags"
        DROP COLUMN IF EXISTS "parent_tag_id",
        DROP COLUMN IF EXISTS "description",
        DROP COLUMN IF EXISTS "needs_reembed"`)
  }
}
