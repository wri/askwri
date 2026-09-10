import { MigrationInterface, QueryRunner } from 'typeorm'

// Experts mode (docs/superpowers/specs/2026-09-09-experts-mode-design.md §5.3):
// query log mirroring cite_mode_query_logs plus a `mode` column
// ('evidence' | 'topic_only'). App-owned; TypeORM entity ExpertsModeQueryLogs.
export class Migration1788000000000 implements MigrationInterface {
  name = 'Migration1788000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "experts_mode_query_logs" ("id" SERIAL NOT NULL, "query" text NOT NULL, "mode" text NOT NULL, "top_ten_people" text NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_experts_mode_query_logs" PRIMARY KEY ("id"))`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "experts_mode_query_logs"`)
  }
}
