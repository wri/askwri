import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1784815300000 implements MigrationInterface {
  name = 'Migration1784815300000'

  public async up(q: QueryRunner): Promise<void> {
    // Retire the text-embedding-3-small partial HNSW index anticipated in
    // 1783454000000's comment ("dropped only after cutover is validated").
    //
    // CONDITIONAL ON PURPOSE. qa finished the cohere-embed-v4 re-embed on
    // 2026-07-23 and has zero 3-small rows, so there the index is empty dead
    // weight. Production has NOT cut over yet, and migrations run there too —
    // an unconditional DROP would remove the index serving production's live
    // dense lane and turn every dense query into a sequential scan over the
    // chunk table. So: drop only where the corpus proves it is unused, and
    // no-op (loudly) everywhere else. Re-running after production's cutover
    // completes the retirement.
    await q.query(`
      DO $$
      DECLARE remaining bigint;
      BEGIN
        SELECT count(*) INTO remaining FROM document_chunks
        WHERE embedding_model = 'text-embedding-3-small';

        IF remaining = 0 THEN
          DROP INDEX IF EXISTS "idx_chunks_embedding_hnsw";
          RAISE NOTICE 'dropped idx_chunks_embedding_hnsw (no 3-small rows)';
        ELSE
          RAISE NOTICE
            'kept idx_chunks_embedding_hnsw — % text-embedding-3-small chunks still present; re-run this migration after that corpus is re-embedded',
            remaining;
        END IF;
      END $$`)
  }

  public async down(q: QueryRunner): Promise<void> {
    // Recreate exactly as 1781280000000 declared it.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "idx_chunks_embedding_hnsw" ON "document_chunks"
      USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
      WHERE embedding_model = 'text-embedding-3-small'`)
  }
}
