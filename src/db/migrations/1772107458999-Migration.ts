import { MigrationInterface, QueryRunner } from "typeorm";

export class Migration1772107458999 implements MigrationInterface {
    name = 'Migration1772107458999'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "cite_mode_feedback" DROP COLUMN "relevance_score"`);
        await queryRunner.query(`ALTER TABLE "cite_mode_feedback" ADD "relevance_score" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "answer_mode_feedback" DROP COLUMN "first_relevance_score"`);
        await queryRunner.query(`ALTER TABLE "answer_mode_feedback" ADD "first_relevance_score" text NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "answer_mode_feedback" DROP COLUMN "first_relevance_score"`);
        await queryRunner.query(`ALTER TABLE "answer_mode_feedback" ADD "first_relevance_score" double precision NOT NULL`);
        await queryRunner.query(`ALTER TABLE "cite_mode_feedback" DROP COLUMN "relevance_score"`);
        await queryRunner.query(`ALTER TABLE "cite_mode_feedback" ADD "relevance_score" double precision NOT NULL`);
    }

}
