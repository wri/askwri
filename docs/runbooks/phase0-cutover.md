# Phase 0 Cutover Runbook

**As-built reference:** [docs/document-management.md](../document-management.md)
**Implementation plan (with parity results):** [docs/plans/2026-06-09-phase0-store-and-migration-plan.md](../plans/2026-06-09-phase0-store-and-migration-plan.md)

---

## Local development setup

### 1. Start a pgvector Postgres container

```bash
docker run -d --name askwri-pg \
  -e POSTGRES_USER=askwri -e POSTGRES_PASSWORD=password -e POSTGRES_DB=qa \
  -p 5432:5432 pgvector/pgvector:pg16
```

Verify pgvector availability:

```bash
docker exec askwri-pg psql -U askwri -d qa \
  -c "SELECT name, default_version FROM pg_available_extensions WHERE name IN ('vector','uuid-ossp');"
```

Expected: two rows; `vector` default_version `0.8.x`.

### 2. Configure `.env`

Required keys for the Node side (TypeORM):

```
DB_HOST=localhost
DB_PORT=5432
DB_USER=askwri
DB_PASSWORD=password
DB_NAME=qa
DATABASE_SSL=false
DATABASE_SSL_REJECT_UNAUTHORIZED=false
DATABASE_URL=postgresql://askwri:password@localhost:5432/qa
```

`DATABASE_SSL=false` is required for a local Docker container (no SSL cert). The default in `src/db/data-source.ts` is SSL-on; omitting this will cause a connection error against Docker.

### 3. Run TypeORM migrations

```bash
npm run migration:run
```

Expected: all migrations apply, including `Migration1781280000000` (11 tables) and `Migration1781290000000` (`corpus_order` column). Output ends with `All migrations have been run successfully.` or `No migrations are pending.`

### 4. Stage documents and cache

For local dev, `DOCUMENTS_LOCAL_DIR=./data` uses the in-repo CSV and any locally cached PDFs/embeddings.

For production assets, sync from S3 first (warm cache avoids re-embedding, ≈$1 cold):

```bash
aws s3 sync "s3://${DOCUMENTS_S3_BUCKET}/${DOCUMENTS_S3_PREFIX:-}" /tmp/askWRI_docs --no-progress
aws s3 sync "s3://${DOCUMENTS_S3_BUCKET}/${CACHE_S3_PREFIX:-}" /tmp/askWRI_cache --no-progress
```

### 5. Run the migration script

```bash
cd search-service
./venv/bin/python -m scripts.migrate_csv_to_postgres
```

With local data dir (no S3):

```bash
cd search-service
DOCUMENTS_LOCAL_DIR=./data ./venv/bin/python -m scripts.migrate_csv_to_postgres
```

Expected output: `Done: 169 documents, <N> chunks.` Warm-cache run makes zero OpenAI calls.

If the table is already populated, the script exits with a clear error. Use `--reset` to wipe and reload:

```bash
./venv/bin/python -m scripts.migrate_csv_to_postgres --reset
```

`--reset` issues `TRUNCATE documents CASCADE`, `TRUNCATE tags CASCADE`, `TRUNCATE collections CASCADE`. The `audit_log` table is **not** truncated (preserved across resets).

### 6. Reranker backend on Macs

The ONNX/CoreML reranker path is ~20x slower on Apple Silicon (MPS). Set `RERANKER_BACKEND=torch` in your local `.env` or shell for acceptable boot times:

```
RERANKER_BACKEND=torch
```

The parity evaluation was run with `RERANKER_BACKEND=torch` on both backends; torch/MPS matches model weights, so logits are equivalent.

---

## Production cutover — step by step

### Step 1: RDS preflight

Run against the production RDS instance before any migration:

```sql
SELECT version();
SELECT name, default_version, installed_version
FROM pg_available_extensions WHERE name IN ('vector', 'uuid-ossp');
```

Requirement: `vector` extension available at version ≥ 0.7.0 (the `sparsevec` type in migration `1781280000000` requires ≥ 0.7; RDS supports 0.8.0 on PG 16.5+/15.9+). If unavailable, a minor RDS engine bump is needed before proceeding. The RDS instance is provisioned outside this repo's Terraform.

### Step 2: Run TypeORM migrations against RDS

```bash
DATABASE_URL="postgresql://user:password@rds-host:5432/db?sslmode=require" npm run migration:run
```

Or set `DATABASE_URL` in your `.env` with `?sslmode=require` appended for RDS. The Node `data-source.ts` defaults to SSL-on; `?sslmode=require` on the URL also satisfies the Python psycopg side.

Expected: `Migration Migration1781280000000 has been executed successfully.` and `Migration Migration1781290000000 has been executed successfully.`

### Step 3: Stage S3 assets and run the migration script

On a host with AWS access and the venv activated:

```bash
aws s3 sync "s3://${DOCUMENTS_S3_BUCKET}/${DOCUMENTS_S3_PREFIX:-}" /tmp/askWRI_docs --no-progress
aws s3 sync "s3://${DOCUMENTS_S3_BUCKET}/${CACHE_S3_PREFIX:-}" /tmp/askWRI_cache --no-progress

cd search-service
DATABASE_URL="postgresql://user:password@rds-host:5432/db?sslmode=require" \
  ./venv/bin/python -m scripts.migrate_csv_to_postgres
```

The script exits non-zero on any error. Expected: `Done: 169 documents, <N> chunks.`

### Step 4: Verification SQL

```sql
SELECT
  (SELECT count(*) FROM documents)                                     AS docs,
  (SELECT count(*) FROM documents WHERE status='searchable')           AS searchable,
  (SELECT count(*) FROM document_texts)                                AS texts,
  (SELECT count(*) FROM document_chunks)                               AS chunks,
  (SELECT count(*) FROM document_chunks WHERE unit_type='summary')     AS summary_chunks,
  (SELECT count(*) FROM document_chunks WHERE embedding IS NULL)       AS missing_embeddings,
  (SELECT count(*) FROM tags)                                          AS tags,
  (SELECT count(*) FROM document_collections)                          AS in_collection;
```

Expected: `docs=169`, `searchable=169`, `texts=169`, `missing_embeddings=0`, `in_collection=169`.

Spot-check a chunk:

```sql
SELECT legacy_chunk_id, unit_type, page, left(text, 60), node_metadata->>'title'
FROM document_chunks WHERE legacy_chunk_id LIKE '%_chunk_0' LIMIT 3;
```

### Step 5: Run parity harness and golden-set evals (release gate)

Start the search-service in postgres mode (port 8001) alongside the running legacy instance (port 8000):

```bash
cd search-service
RETRIEVAL_BACKEND=postgres ./venv/bin/python -m uvicorn app.main:app --port 8001
```

Run the comparison script:

```bash
./venv/bin/python -m scripts.compare_query_parity \
  --legacy http://127.0.0.1:8000 --candidate http://127.0.0.1:8001
```

Gate: exit 0, mean top-20 overlap ≥ 0.95, no rank-1 mismatches.

Then run the full evals against the postgres backend (switch to port 8000):

```bash
npm run eval:cite
npm run eval:answer-retrieval
```

Acceptance criteria (design §14.5):
- Cite precision/F1: within ±1 point of legacy baseline.
- Answer chunk-level P/R/F1: within ±2 points.
- Answer doc-level P/R/F1: within ±2 points.

### Step 6: Flip the env flags and deploy

In the ECS task definitions:

- Search-service task: add `RETRIEVAL_BACKEND=postgres` and `DATABASE_URL` (as a secret). Remove or keep `DOCUMENTS_S3_BUCKET`/`DOCUMENTS_S3_PREFIX`/`CACHE_S3_PREFIX` — the startup script (`start.sh`) skips the S3 sync when `RETRIEVAL_BACKEND=postgres`.
- Next.js task: add `CATALOG_SOURCE=postgres` to serve `/api/catalog` from Postgres.

Deploy both task definitions. The search-service boots in seconds (no CSV/PDF parsing, no OpenAI calls at startup).

### Step 7: Rollback

Rollback is an env-flag change only — the legacy code path is intact.

1. Remove or set `RETRIEVAL_BACKEND=legacy` in the search-service task definition.
2. Remove or unset `CATALOG_SOURCE=postgres` in the Next.js task definition.
3. The search-service reverts to CSV+S3 boot and the S3 sync re-enables automatically (the `start.sh` condition `if [ "$RETRIEVAL_BACKEND" = "postgres" ]` no longer matches).
4. No schema rollback needed; the new tables are additive.

---

## Reprocessing notes

### Re-running the migration script (`--reset`)

`--reset` truncates `documents`, `tags`, and `collections` tables (CASCADE drops all child rows including chunks, summaries, tags, collection memberships). `audit_log` is **preserved** across resets. After reset, the script repopulates everything from the CSV + caches.

Use `--reset` when: re-running after a schema change, correcting a migration error, or re-seeding tags.

### `/reindex` endpoint

`POST /reindex` re-runs the active boot path in-process (synchronous, blocks until complete):

- **Legacy mode:** re-parses CSV + PDFs, rebuilds in-memory dense and BM25 indexes.
- **Postgres mode:** re-reads `document_chunks` from Postgres, rebuilds the in-memory BM25 index, re-instantiates `PgVectorRetriever`. Dense vectors are not re-embedded.

Use `/reindex` after:
- Withdrawing or adding documents (to update the BM25 lane — see [BM25 gotcha in the as-built reference](../document-management.md#4-document-lifecycle)).
- Running the migration script with `--reset` while the service is live.

---

## Testing

### Suites

| Suite | Command | Needs |
|---|---|---|
| Jest unit (23 tests) | `npm test` | nothing |
| Jest DB integration (3 tests, catalog from Postgres) | `npm run test:db` | local migrated DB |
| Python full suite (45 tests) | `npm run test:python` (or `cd search-service && ./venv/bin/python -m pytest tests/`) | local migrated DB for integration modules |
| Python coverage | `cd search-service && ./venv/bin/python -m pytest tests/ --cov=app --cov=scripts --cov-report=term` | same |

Python test layout:
- `tests/test_indexing.py` — pure-unit chunking/node-build tests (no DB/network).
- `tests/test_migration_script.py` — hermetic migration-script integration tests: creates a scratch `askwri_test` database, applies the TypeORM migrations via subprocess, runs the script against a synthetic 3-doc CSV with fake embeddings, asserts all data invariants (counts, chunk-id format, contiguous `corpus_order`, no null embeddings, tags/summaries/collection/audit) plus idempotency-guard and `--reset` behavior. Never touches the `qa` data.
- `tests/test_query_e2e.py` — `/query` contract tests in postgres mode against the real local DB (stubbed rerankers + query embedding; read-only, except a withdrawn-doc test that restores state in `finally`). Covers cite/answer/diagnostic modes and dense-lane withdrawn-doc exclusion.
- `tests/test_pg_store.py` — Postgres store loaders + `PgVectorRetriever` (the dense-retrieval test calls OpenAI once and needs `OPENAI_API_KEY`).

`tests/conftest.py` auto-loads `search-service/.env`, so no env exporting is needed locally. Integration modules skip when `DATABASE_URL` is unset — **set `REQUIRE_DB_TESTS=1` in CI to turn those skips into hard failures** (prevents false-green runs).

### CI recommendation

CI exists in `.github/workflows/` (`pr-check.yml` and the deploy workflows run `npm run test:ci` + build), but the **Python suite is not wired in**. The Jest DB-gated tests skip gracefully when `DATABASE_URL` is absent, so current CI stays green without a database. Recommended addition to `pr-check.yml`:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    env:
      POSTGRES_USER: askwri
      POSTGRES_PASSWORD: password
      POSTGRES_DB: qa
    ports:
      - 5432:5432
env:
  DATABASE_URL: postgresql://askwri:password@localhost:5432/qa
  DATABASE_SSL: "false"
  REQUIRE_DB_TESTS: "1"
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
steps:
  - run: npm run migration:run
  - run: cd search-service && ./venv/bin/python -m scripts.migrate_csv_to_postgres
  - run: npm test
  - run: npm run test:db
  - run: npm run test:python
```

Note: the migration-script tests create their own scratch database, so the CI job only needs the empty migrated `qa` schema for the e2e/pg_store/catalog tests — except those expect the migrated corpus (169 docs). For corpus-dependent tests in CI, either stage the corpus via the migration script with real assets, or scope CI to the hermetic modules (`test_indexing.py`, `test_migration_script.py`) until an artifact pipeline exists. Without `OPENAI_API_KEY`, the one dense-retrieval test skips (acceptable — it incurs OpenAI spend per run).

---

## Phase 1 worker — local dev

This section covers running the ingestion worker locally. It assumes the Phase 0 local setup (§1–5 above) is already complete: Postgres container running, migrations applied, and the venv available at `search-service/venv/`.

### Worker env vars (add to `.env`)

```
INTAKE_LOCAL_DIR=./intake
WORKER_LLM_MODEL=gpt-5-mini
WORKER_POLL_SECONDS=10
WORKER_MAX_ATTEMPTS=3
TAG_CONFIDENCE_ACCEPT=0.7
QUALITY_MIN_CHARS_PER_PAGE=200
SEARCH_SERVICE_URL=http://localhost:8000
OPENAI_API_KEY=<your key>
```

`INTAKE_LOCAL_DIR` activates local-dev mode: the worker watches the specified directory for PDFs instead of S3. Files are moved to a sibling `documents/` directory (`./documents/` relative to the worker's working directory) after registration.

`DOCUMENTS_S3_BUCKET` / `DOCUMENTS_S3_PREFIX` are not required when `INTAKE_LOCAL_DIR` is set — the worker bypasses S3 for intake. They are still required for the embed stage if PDFs need to be fetched from S3 during processing; for purely local testing, place PDFs in `INTAKE_LOCAL_DIR` and ensure `DOCUMENTS_LOCAL_DIR` is set so the parse stage can find them.

### Dropping a PDF and running the pipeline

1. Create the intake directory if it does not exist:

   ```bash
   mkdir -p search-service/intake
   ```

2. Copy a PDF into it:

   ```bash
   cp /path/to/sample.pdf search-service/intake/
   ```

3. Run one worker step with `--once` (one intake sweep + one job-stage advance):

   ```bash
   cd search-service && ./venv/bin/python -m worker.main --once
   ```

   After the first `--once` run the PDF is moved out of `intake/` into `documents/` and a `draft` document + queued job appear in the database. Each subsequent `--once` call advances the job one stage.

4. Check job progress:

   ```sql
   SELECT d.external_id, d.status, j.stage, j.status, j.attempts, j.error
   FROM ingestion_jobs j
   JOIN documents d ON d.id = j.document_id
   ORDER BY j.created_at DESC
   LIMIT 10;
   ```

   Stages in order: `parse → language → summarize → classify → embed → publish`. The `stage` column shows the last **completed** stage; `status` shows the job's current state (`queued`, `running`, `done`, `needs_review`, `error`).

5. Repeat `--once` calls until `j.status = 'done'` (or `needs_review` / `error`). A full pipeline run takes 5–6 `--once` invocations.

   To run continuously instead of stepping:

   ```bash
   cd search-service && ./venv/bin/python -m worker.main
   ```

   The worker polls every `WORKER_POLL_SECONDS` seconds (default 10).

6. Verify the published document:

   ```sql
   SELECT id, external_id, status, language, extraction_confidence
   FROM documents WHERE external_id = 'sample';
   ```

   Expected `status='searchable'` (or `needs_review` if extraction confidence < 0.7 — e.g. a very short or image-only PDF). If `needs_review`, see [§10.5 of the as-built reference](../document-management.md#105-document-lifecycle-update) for the promotion query.

### Where files move

| State | Location |
|---|---|
| Before worker runs | `INTAKE_LOCAL_DIR/` (e.g. `./intake/sample.pdf`) |
| After intake sweep | `./documents/sample.pdf` (sibling `documents/` dir) |

### Retry behavior

If a stage fails (e.g. OpenAI call error), the job is requeued for the same stage with `attempts+1`. After `WORKER_MAX_ATTEMPTS` (default 3) failures the job status becomes `error`. To inspect errors:

```sql
SELECT d.external_id, j.stage, j.attempts, j.error
FROM ingestion_jobs j
JOIN documents d ON d.id = j.document_id
WHERE j.status = 'error';
```

Fix the underlying issue (e.g. missing API key, network error) and reset the job manually to retry:

```sql
UPDATE ingestion_jobs SET status = 'queued', attempts = 0, error = NULL
WHERE id = '<job-uuid>';
```

### Deploy note

The ingestion worker (`ingestion-worker` ECS service) runs the same container image as the search-service with command override `python -m worker.main`. It has no ALB or service-discovery endpoint and runs as a single task (`desired_count=1`). Deploying is handled by the existing deploy workflows, which force-new-deployment for the worker alongside the search-service and Next.js tasks. No separate `terraform plan/apply` is needed for normal deployments; Terraform changes to the worker service definition are an ops action.
