import { MigrationInterface, QueryRunner } from "typeorm";

export class Migration1772106827872 implements MigrationInterface {
    name = 'Migration1772106827872'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "cite_mode_feedback" ("id" SERIAL NOT NULL, "query" text NOT NULL, "doc_id" character varying(64) NOT NULL, "relevance_score" double precision NOT NULL, "publication_name" character varying(256) NOT NULL, "row_number" integer NOT NULL, "summary" text NOT NULL, "how_relevant" text NOT NULL, "feedback" character varying(8) NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_92d5a9b7baab294d3073883b54c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "answer_mode_feedback" ("id" SERIAL NOT NULL, "answer" text NOT NULL, "query" text NOT NULL, "consulted_doc_ids" text, "cited_doc_ids" text NOT NULL, "first_relevance_score" double precision NOT NULL, "first_publication_name" character varying(256) NOT NULL, "first_doc_summary" text NOT NULL, "first_doc_how_relevant" text NOT NULL, "feedback" character varying(8) NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_13dda1b4f80899491aaf4c4d770" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "answer_mode_feedback"`);
        await queryRunner.query(`DROP TABLE "cite_mode_feedback"`);
    }

}
