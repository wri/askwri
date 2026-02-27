import { MigrationInterface, QueryRunner } from "typeorm";

export class Migration1772038063520 implements MigrationInterface {
    name = 'Migration1772038063520'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "user_feedback" ("id" SERIAL NOT NULL, "mode" character varying(16) NOT NULL, "query" text NOT NULL, "doc_id" character varying(64) NOT NULL, "relevance_score" double precision NOT NULL, "publication_name" character varying(256) NOT NULL, "row_number" integer NOT NULL, "summary" text NOT NULL, "how_relevant" text NOT NULL, "feedback" character varying(8), "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_94fb2b9415a96bde222d5e40598" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "user_feedback"`);
    }

}
