import { MigrationInterface, QueryRunner } from "typeorm";

export class Migration1772115557037 implements MigrationInterface {
    name = 'Migration1772115557037'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "answer_mode_feedback" RENAME COLUMN "cited_doc_ids" TO "supporting_doc_ids"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "answer_mode_feedback" RENAME COLUMN "supporting_doc_ids" TO "cited_doc_ids"`);
    }

}
