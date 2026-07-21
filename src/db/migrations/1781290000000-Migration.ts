import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1781290000000 implements MigrationInterface {
  name = 'Migration1781290000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // BM25 breaks score ties by corpus position, so the chunk load order must
    // reproduce the legacy node build order exactly for retrieval parity.
    await queryRunner.query(
      `ALTER TABLE "document_chunks" ADD COLUMN "corpus_order" integer`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_chunks_corpus_order" ON "document_chunks" ("corpus_order")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_chunks_corpus_order"`)
    await queryRunner.query(
      `ALTER TABLE "document_chunks" DROP COLUMN "corpus_order"`,
    )
  }
}
