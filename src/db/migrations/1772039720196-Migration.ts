import { MigrationInterface, QueryRunner } from "typeorm";

export class Migration1772039720196 implements MigrationInterface {
    name = 'Migration1772039720196'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user_feedback" ALTER COLUMN "feedback" SET NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user_feedback" ALTER COLUMN "feedback" DROP NOT NULL`);
    }

}
