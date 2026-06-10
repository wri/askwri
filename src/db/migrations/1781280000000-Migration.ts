import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1781280000000 implements MigrationInterface {
  name = 'Migration1781280000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`)
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)

    await queryRunner.query(`
      CREATE TABLE "documents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "external_id" text NOT NULL,
        "doi" text,
        "s3_key" text NOT NULL,
        "title" text,
        "title_en" text,
        "abstract" text,
        "language" text,
        "languages" text array,
        "year_published" integer,
        "publication_title" text,
        "article_type" text,
        "wri_primary_office" text,
        "content_hash" text,
        "extraction_confidence" numeric,
        "status" text NOT NULL DEFAULT 'draft',
        "source_metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_documents_external_id" UNIQUE ("external_id"),
        CONSTRAINT "PK_documents" PRIMARY KEY ("id")
      )`)
    await queryRunner.query(
      `CREATE INDEX "idx_documents_status" ON "documents" ("status")`,
    )

    await queryRunner.query(`
      CREATE TABLE "document_texts" (
        "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "full_text" text NOT NULL,
        "page_boundaries" jsonb NOT NULL DEFAULT '[]',
        "char_count" integer NOT NULL,
        CONSTRAINT "PK_document_texts" PRIMARY KEY ("document_id")
      )`)

    await queryRunner.query(`
      CREATE TABLE "document_summaries" (
        "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "language" text NOT NULL,
        "kind" text NOT NULL,
        "text" text NOT NULL,
        "source" text NOT NULL,
        "model_version" text,
        CONSTRAINT "PK_document_summaries" PRIMARY KEY ("document_id", "language", "kind")
      )`)

    await queryRunner.query(`
      CREATE TABLE "document_chunks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "legacy_chunk_id" text,
        "chunk_index" integer NOT NULL,
        "unit_type" text NOT NULL DEFAULT 'text',
        "unit_number" text,
        "section_path" text,
        "page" integer,
        "caption" text,
        "text" text NOT NULL,
        "structured" jsonb,
        "language" text,
        "node_metadata" jsonb NOT NULL DEFAULT '{}',
        "embedding" vector,
        "embedding_model" text,
        "dimension" integer,
        "sparse" sparsevec,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_document_chunks_legacy_chunk_id" UNIQUE ("legacy_chunk_id"),
        CONSTRAINT "PK_document_chunks" PRIMARY KEY ("id")
      )`)
    await queryRunner.query(
      `CREATE INDEX "idx_chunks_document" ON "document_chunks" ("document_id")`,
    )
    await queryRunner.query(`
      CREATE INDEX "idx_chunks_embedding_hnsw" ON "document_chunks"
      USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
      WHERE embedding_model = 'text-embedding-3-small'`)

    await queryRunner.query(`
      CREATE TABLE "tags" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "facet" text NOT NULL,
        "value_id" text NOT NULL,
        "taxonomy_version" text NOT NULL DEFAULT 'v1',
        CONSTRAINT "UQ_tags_facet_value_version" UNIQUE ("facet", "value_id", "taxonomy_version"),
        CONSTRAINT "PK_tags" PRIMARY KEY ("id")
      )`)

    await queryRunner.query(`
      CREATE TABLE "document_tags" (
        "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
        "source" text NOT NULL,
        "confidence" numeric,
        "model_version" text,
        "status" text NOT NULL DEFAULT 'accepted',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_document_tags" PRIMARY KEY ("document_id", "tag_id")
      )`)

    await queryRunner.query(`
      CREATE TABLE "collections" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" text NOT NULL,
        "slug" text NOT NULL,
        "description" text,
        "owner" text,
        "visibility" text NOT NULL DEFAULT 'internal',
        "language_policy" jsonb,
        "embedding_model_version" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_collections_slug" UNIQUE ("slug"),
        CONSTRAINT "PK_collections" PRIMARY KEY ("id")
      )`)

    await queryRunner.query(`
      CREATE TABLE "document_collections" (
        "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "collection_id" uuid NOT NULL REFERENCES "collections"("id") ON DELETE CASCADE,
        "added_by" text,
        "added_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_document_collections" PRIMARY KEY ("document_id", "collection_id")
      )`)

    await queryRunner.query(`
      CREATE TABLE "ingestion_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "document_id" uuid REFERENCES "documents"("id") ON DELETE SET NULL,
        "stage" text,
        "status" text NOT NULL DEFAULT 'queued',
        "error" text,
        "attempts" integer NOT NULL DEFAULT 0,
        "model_versions" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ingestion_jobs" PRIMARY KEY ("id")
      )`)
    await queryRunner.query(
      `CREATE INDEX "idx_ingestion_jobs_status" ON "ingestion_jobs" ("status")`,
    )

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "username" text NOT NULL,
        "email" text,
        "password_hash" text NOT NULL,
        "role" text NOT NULL DEFAULT 'editor',
        "active" boolean NOT NULL DEFAULT true,
        "last_login" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_users_username" UNIQUE ("username"),
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )`)

    await queryRunner.query(`
      CREATE TABLE "audit_log" (
        "id" BIGSERIAL NOT NULL,
        "actor_user_id" uuid,
        "source" text NOT NULL,
        "action" text NOT NULL,
        "entity_type" text NOT NULL,
        "entity_id" uuid,
        "before" jsonb,
        "after" jsonb,
        "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_audit_log" PRIMARY KEY ("id")
      )`)
    await queryRunner.query(
      `CREATE INDEX "idx_audit_log_entity" ON "audit_log" ("entity_type", "entity_id")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "audit_log"`)
    await queryRunner.query(`DROP TABLE "users"`)
    await queryRunner.query(`DROP TABLE "ingestion_jobs"`)
    await queryRunner.query(`DROP TABLE "document_collections"`)
    await queryRunner.query(`DROP TABLE "collections"`)
    await queryRunner.query(`DROP TABLE "document_tags"`)
    await queryRunner.query(`DROP TABLE "tags"`)
    await queryRunner.query(`DROP TABLE "document_chunks"`)
    await queryRunner.query(`DROP TABLE "document_summaries"`)
    await queryRunner.query(`DROP TABLE "document_texts"`)
    await queryRunner.query(`DROP TABLE "documents"`)
  }
}
