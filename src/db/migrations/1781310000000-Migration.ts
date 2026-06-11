import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1781310000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Vocabulary for the Postgres-resident BM25 lane (KEYWORD_BACKEND=sparse).
    // token_id is a stable 1-based id = sparsevec dimension index; rows are
    // never re-numbered by refreshes (data writes owned by the Python side).
    await queryRunner.query(`
      CREATE TABLE "keyword_vocab" (
        "token" text NOT NULL,
        "token_id" integer GENERATED ALWAYS AS IDENTITY,
        "df" integer NOT NULL,
        "idf" double precision NOT NULL,
        CONSTRAINT "PK_keyword_vocab" PRIMARY KEY ("token"),
        CONSTRAINT "UQ_keyword_vocab_token_id" UNIQUE ("token_id")
      )`)
    // Frozen corpus statistics the BM25 weights were computed under.
    // n_chunks = bm25s num_docs (chunks, not documents).
    await queryRunner.query(`
      CREATE TABLE "keyword_corpus_stats" (
        "id" integer NOT NULL DEFAULT 1 CHECK (id = 1),
        "n_chunks" integer NOT NULL,
        "avgdl" double precision NOT NULL,
        "k1" real NOT NULL,
        "b" real NOT NULL,
        "sparse_dim" integer NOT NULL,
        "method" text NOT NULL DEFAULT 'lucene',
        "built_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_keyword_corpus_stats" PRIMARY KEY ("id")
      )`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "keyword_corpus_stats"`)
    await queryRunner.query(`DROP TABLE "keyword_vocab"`)
  }
}
