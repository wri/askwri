# AskWRI — Repo Orientation

Research interface over WRI's published corpus. Three services:

| Concern | Where | Runtime |
|---|---|---|
| Web app + admin + relational CRUD | `src/` (Next.js 16 App Router, TypeORM 0.3) | Node |
| Retrieval (`/query` hybrid search) | `search-service/` (FastAPI + LlamaIndex) | Python 3.12 |
| Evaluation harness + golden sets | `evaluation/` (tsx scripts) | Node |

Deployed on AWS ECS Fargate via `terraform/`; RDS Postgres (provisioned OUTSIDE this repo's
Terraform); S3 for PDFs and derived artifacts.

## Commands
- `npm run dev` / `npm run build` — Next.js. Local prod builds: `npx next build --webpack`
  (Turbopack panics on the `search-service/venv` symlink).
- `npm test` — Jest (jsdom); `npm run lint`; `npm run format:check`
- `npm run migration:generate` / `migration:run` / `migration:revert` — TypeORM (needs `.env` DB vars)
- Search service: `cd search-service && ./venv/bin/python -m app.main` on :8000
  (`npm run search-service` is broken locally — venv has no `pip` shim;
  `npm run search-service:stop` to kill)
- `npm run test:python` (or `cd search-service && ./venv/bin/python -m pytest tests/ -v`) — Python tests
- Python deps are PINNED: edit `search-service/requirements.in`, then run
  `search-service/scripts/compile-requirements.sh` to regenerate the `.txt`
  (compiles inside `python:3.12-slim` so pins match the deploy image). Never
  hand-edit `requirements.txt`.
- `npm run eval:cite` / `npm run eval:answer-retrieval` — retrieval evals (search-service must be running)
- `npm run eval:qa` — gen-2 evalsets against deployed QA via its public gateway;
  no local service, DB, or AWS creds. Fixtures come from the
  `evaluation/eval-review` submodule (`git submodule update --init` on first checkout).
- `./scripts/local-bootstrap.sh` — one-command local stack (docker pgvector Postgres
  \+ MinIO via `docker-compose.local.yml`, migrations, corpus, sparse backfill, bucket
  seed, admin user `admin`/`admin-local-password`). Idempotent. Details:
  `docs/runbooks/local-testing.md`.
- `./scripts/with-remote-env.sh <qa|production> <cmd>` — run any command against a
  deployed environment's RDS (host/creds read from that env's ECS task definition).
- `./scripts/clone-corpus.sh <source> <target>` / `./scripts/verify-corpus-parity.sh
  <a> <b>` — mirror one environment's corpus into another and prove the result.
  Direction is an argument: qa → production seeded the 2026-08-07 cutover;
  production → qa is the future refresh. See
  `docs/runbooks/prod-cutover-multilingual-v3.md`.

## Conventions (follow, don't invent)
- API routes: `src/app/api/<name>/route.ts` → call `initializeDatabase()` → call a function in
  `src/db/queries/<fn>.ts` which wraps `AppDataSource.getRepository(Entity)`.
- Entities: `src/db/entities/<Name>.entity.ts`, snake_case column names via `name:` options.
- Migrations: `src/db/migrations/<epoch_ms>-Migration.ts`, raw SQL through `queryRunner.query`.
  `synchronize` is always false. pgvector columns (`vector`, `sparsevec`) are NOT TypeORM-native:
  declare that DDL as raw SQL in migrations; no entity maps `document_chunks`/`document_texts`.
- Write ownership: app tier owns relational tables (`documents`, `document_summaries`, `tags`,
  `document_tags`, `collections`, `document_collections`, `ingestion_jobs`, `users`, `audit_log`).
  The Python side (search-service / ingestion worker) owns `document_chunks`, `document_texts`,
  `document_summaries` (worker-generated), `keyword_vocab` (raw SQL), and may also write
  `documents` (draft rows + status/language/title_en/extraction_confidence updates),
  `document_tags` (`source='llm'` only), `ingestion_jobs`, and `audit_log`.
  Never modify `document_tags` rows with `source='human'` or `source='external'`.
  One owner per domain; two-writer tables are managed by precedence invariants.
- Path alias `@/*` → `src/*`.
- Search-service settings live in `search-service/app/config.py` (pydantic-settings, `.env`).

## Env vars
See `.env.example`. DB: `DATABASE_URL` (or `DB_HOST/PORT/USER/PASSWORD/NAME`). Search:
`SEARCH_SERVICE_URL`, `LLAMAINDEX_SERVICE_URL`. OpenAI: `OPENAI_API_KEY` (+ model overrides).
Search-service: `RETRIEVAL_BACKEND` (`legacy`|`postgres`), `KEYWORD_BACKEND` (`sparse` default |
`memory` legacy), `SPARSE_EN_HANDLES` (`false` default — English handles into sparse weights,
must match across backfill shell + worker env), `DOCUMENTS_LOCAL_DIR`, `CACHE_DIR`,
S3 sync vars (`DOCUMENTS_S3_BUCKET`, `DOCUMENTS_S3_PREFIX`, `CACHE_S3_PREFIX`).
Admin auth: `SESSION_SECRET` (>= 32 chars, required for `/admin`), `ADMIN_API_TOKEN` (optional bearer).

## Local dev env files (no AWS)

Gitignored overrides; precedence everywhere: real env > `.env.local` > `.env`.
Never edit `.env` / `search-service/.env` for local values — they are the
deploy-day reference.

| File | Loaded by |
|---|---|
| `.env.local` | Next.js dev/prod; `scripts/load-env.js` (typeorm/seed CLIs) |
| `.env.test.local` | Jest only — `NODE_ENV=test` makes Next.js skip `.env.local` |
| `search-service/.env.local` | pydantic Settings (`app/config.py`) AND `app/env.py` → `os.environ` (boto3 reads the process env, not Settings) |

S3 locally = MinIO (`AWS_ENDPOINT_URL=http://localhost:9000`, console :9001).
Testing the worker's S3 intake lane requires `INTAKE_LOCAL_DIR` to be UNSET.
Worker e2e PDFs: generate with `scripts.make_canary_pdf` (content-hash dedup
rejects re-dropped identical files).

## Document management docs
See `docs/document-management.md` (as-built reference, Phases 0-2 + sparse keyword lane) and `docs/runbooks/phase0-cutover.md` (cutover + local dev setup).
Local testing without AWS: `docs/runbooks/local-testing.md` (substitutes, suites, lane checks, worker e2e).
Deploys: `docs/runbooks/qa-push-deploy.md` (push ordering, migrations, sparse backfill, rollback).

## Out of scope for document-management work
Retrieval tuning (RRF weights, rerankers, thresholds/tiers), answer synthesis, and eval
internals are separate workstreams. Preserve the `/query` request/response contract
(`QueryRequest`/`QueryResponse` in `search-service/app/main.py`) exactly.

<!-- BEGIN aws-agent-rules (AWS Agent Toolkit, added 2026-07-21) -->
<!-- Source: https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/refs/heads/main/rules/aws-agent-rules.md -->
<!-- Regenerate by re-fetching that URL; edits below will be lost on refresh. -->

# AWS Guidance

- Prefer the AWS MCP Server for AWS interactions — it provides sandboxed
  execution, observability, and audit logging. If unavailable, use the
  AWS CLI directly.
- Before starting a task, check whether a relevant AWS skill is available.
  Load the skill with `retrieve_skill` and prefer its guidance over
  general knowledge.
- When uncertain about specific AWS details (API parameters, permissions,
  limits, error codes), verify against documentation rather than guessing.
  State uncertainty explicitly if you cannot confirm.
- When creating infrastructure, prefer infrastructure-as-code (AWS CDK or
  CloudFormation) over direct CLI commands.
- When working with infrastructure, follow AWS Well-Architected Framework
  principles.
- Do not use em dashes in AWS resource names or descriptions. Use
  hyphens instead.

## Secret Safety

- MUST load the `aws-secrets-manager` skill first for any secret,
  credential, API key, token, or password task. MUST NOT call
  `secretsmanager get-secret-value` or `batch-get-secret-value`, and MUST
  NOT hit the Secrets Manager Agent daemon directly. MUST use
  `{{resolve:secretsmanager:secret-id:SecretString:json-key}}` with
  `asm-exec` so the secret resolves at runtime without entering context.

<!-- END aws-agent-rules -->
