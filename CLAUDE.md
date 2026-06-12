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
- `npm run eval:cite` / `npm run eval:answer-retrieval` — retrieval evals (search-service must be running)

## Conventions (follow, don't invent)
- API routes: `src/app/api/<name>/route.ts` → call `initializeDatabase()` → call a function in
  `src/db/queries/<fn>.ts` which wraps `AppDataSource.getRepository(Entity)`.
- Entities: `src/db/entities/<Name>.entity.ts`, snake_case column names via `name:` options.
- Migrations: `src/db/migrations/<epoch_ms>-Migration.ts`, raw SQL through `queryRunner.query`.
  `synchronize` is always false. pgvector columns (`vector`, `sparsevec`) are NOT TypeORM-native:
  declare that DDL as raw SQL in migrations; no entity maps `document_chunks`/`document_texts`.
- Write ownership: app tier owns relational tables; the Python side owns `document_chunks` rows
  (raw SQL) and only those. One owner per domain.
- Path alias `@/*` → `src/*`.
- Search-service settings live in `search-service/app/config.py` (pydantic-settings, `.env`).

## Env vars
See `.env.example`. DB: `DATABASE_URL` (or `DB_HOST/PORT/USER/PASSWORD/NAME`). Search:
`SEARCH_SERVICE_URL`, `LLAMAINDEX_SERVICE_URL`. OpenAI: `OPENAI_API_KEY` (+ model overrides).
Search-service: `RETRIEVAL_BACKEND` (`legacy`|`postgres`), `KEYWORD_BACKEND` (`sparse` default |
`memory` legacy), `DOCUMENTS_LOCAL_DIR`, `CACHE_DIR`,
S3 sync vars (`DOCUMENTS_S3_BUCKET`, `DOCUMENTS_S3_PREFIX`, `CACHE_S3_PREFIX`).
Admin auth: `SESSION_SECRET` (>= 32 chars, required for `/admin`), `ADMIN_API_TOKEN` (optional bearer).

## Document management docs
See `docs/document-management.md` (as-built reference, Phases 0-2 + sparse keyword lane) and `docs/runbooks/phase0-cutover.md` (cutover + local dev setup).
Deploys: `docs/runbooks/qa-push-deploy.md` (push ordering, migrations, sparse backfill, rollback).

## Out of scope for document-management work
Retrieval tuning (RRF weights, rerankers, thresholds/tiers), answer synthesis, and eval
internals are separate workstreams. Preserve the `/query` request/response contract
(`QueryRequest`/`QueryResponse` in `search-service/app/main.py`) exactly.
