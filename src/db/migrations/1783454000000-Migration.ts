import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1783454000000 implements MigrationInterface {
  name = 'Migration1783454000000'

  public async up(q: QueryRunner): Promise<void> {
    // v3 B1 (multilingual spec §8.1): scoped HNSW index for Cohere embed-v4
    // rows (1536-d, via Bedrock), alongside the existing
    // text-embedding-3-small index so both models coexist during the cutover
    // window. The 3-small index is dropped only after cutover is validated.
    await q.query(`
      CREATE INDEX "idx_chunks_embedding_hnsw_cohere_v4" ON "document_chunks"
      USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
      WHERE embedding_model = 'cohere-embed-v4'`)
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_chunks_embedding_hnsw_cohere_v4"`)
  }
}
