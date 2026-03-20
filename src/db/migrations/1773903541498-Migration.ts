import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1773903541498 implements MigrationInterface {
  name = 'Migration1773903541498'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "answer_mode_query_logs" ("id" SERIAL NOT NULL, "query" text NOT NULL, "answer" text NOT NULL, "top_ten_results" text NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_df15c6f472d8517a18c1bcdc5e9" PRIMARY KEY ("id"))`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "answer_mode_query_logs"`)
  }
}
