import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1773833444858 implements MigrationInterface {
  name = 'Migration1773833444858'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "cite_mode_query_logs" ("id" SERIAL NOT NULL, "query" text NOT NULL, "top_ten_results" text NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_8c97f4e8d5fb7c4e2d369f6b793" PRIMARY KEY ("id"))`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "cite_mode_query_logs"`)
  }
}
