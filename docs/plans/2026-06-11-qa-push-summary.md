# QA push summary — document management (Phases 0–2) + sparse keyword lane

**Audience:** reviewer/operator handling the first push of this work to `qa`.
**Deploy procedure:** [docs/runbooks/qa-push-deploy.md](../runbooks/qa-push-deploy.md) — follow it in order; pushing without the RDS prep bricks `/query`.

## What's in the push

92 commits at time of writing (verify: `git rev-list --count origin/qa..HEAD`), all local-only until now:

| Workstream | Merge / range | Summary |
|---|---|---|
| Phase 0 — store + migration | direct commits `87fcb0c` … `883dc2f` | 11-table pgvector schema; CSV+cache one-time migration; `RETRIEVAL_BACKEND=postgres` (dense lane via SQL); `CATALOG_SOURCE=postgres`; parity-gated (design §14.5 PASS) |
| Phase 1 — ingestion | merge `0c9d3a5` | Durable `ingestion_jobs` queue worker (parse → language → summarize → classify → embed → publish), S3/local intake with content-hash dedup, CSV import API, worker ECS service + CI wiring |
| Phase 2 — admin UI | merge `ba93dad` | Username/password auth (bcryptjs + jose JWT cookie), role-gated admin pages (review queue, catalog, document editor, collections, taxonomy, users, upload), full audit logging |
| Sparse keyword lane | merge `3770a61` | In-memory BM25 replaced by Postgres-resident impact vectors in `document_chunks.sparse`; `KEYWORD_BACKEND=sparse` default; both lanes now filter `status='searchable'` per query — reindex choreography deleted |
| Review-fix wave 1 | merge `a966c5b` | Full-corpus multi-agent review of Phases 0–2: security (`d94ee5e`), correctness (`801584a`), UI (`1e8d655`), worker lifecycle (`04f3248`) |
| Review-fix wave 2 | `51dad39`, `15d6742`, `f27ce04` | Post-sparse review: app-tier findings, sparse/worker findings (identity burn, poison-file resilience, reaper hardening), eval-harness integrity |

## New env vars / secrets (must exist before deploy)

| Where | Var | Notes |
|---|---|---|
| GitHub secret (new) | `INGESTION_WORKER_ENV` | JSON env for the worker task: `DATABASE_URL` + `OPENAI_API_KEY`. Read by both deploy workflows |
| GitHub secret `ASKWRI_APP_ENV` (add keys) | `SESSION_SECRET` | ≥ 32 chars; app refuses admin sessions without it |
| same | `ADMIN_API_TOKEN` | optional; machine-to-machine admin bearer (audited as `source='system'`) |
| search-service env | `KEYWORD_BACKEND` | `sparse` (default) \| `memory` (legacy lane, the rollback flip) |
| worker env | `WORKER_REAP_MINUTES` | stale-job reaper threshold, default 15 |

## Migrations pending on RDS

Two migrations from this push are not on RDS: `1781300000000` (open-ingestion-job dedupe +
unique index + FK → `ON DELETE CASCADE`; the dedupe **deletes** duplicate open jobs — run in
a quiet window) and `1781310000000` (`keyword_vocab` + `keyword_corpus_stats`).

Whether the Phase 0/1 migrations (`1781280000000`, `1781290000000`) and the corpus migration
script ever ran against RDS could not be verified from the repo — **check before anything
else**:

```bash
DATABASE_URL="postgresql://…rds…?sslmode=require" \
  npm run typeorm -- migration:show -d src/db/migration-data-source.ts
```

`[X]` = applied, `[ ]` = pending. If `1781280000000`/`1781290000000` are pending, run the
full [phase0-cutover.md](../runbooks/phase0-cutover.md) first. After migrations, the sparse
backfill (`scripts/build_sparse_keyword.py`) **must** run before the new search-service
boots (sparse boot guard; runbook Step 3).

## Operational changes

- **Worker deploys are stop-then-start** (`deployment_minimum_healthy_percent = 0`): never
  two worker revisions concurrently; brief ingestion pause per deploy is by design.
- **Stale-job reaper**: `running` jobs idle > `worker_reap_minutes` are requeued each poll —
  worker crashes/replacements no longer orphan jobs.
- **Poison-file resilience**: a bad intake file costs one log line per sweep and never
  blocks other files.
- **`/reindex` semantics changed**: under sparse it only refreshes in-memory
  passage-context texts/metadata (build-then-swap, ~11 s, `409` when already running); it is
  no longer needed for lifecycle correctness. Fired automatically by worker publish and
  admin promote.
- `/health` now reports `keyword_backend` + `retrieval_backend` (used by verification and
  the eval runners' identity stamps).

## Known limitations / accepted risks

- **JWT revocation lag**: sessions are stateless; deactivating a user doesn't invalidate
  existing cookies for up to the 7-day TTL (documented, accepted for an internal tool).
- **Login rate limit is per-instance** (in-memory map; resets on deploy, not shared across
  tasks).
- **Frozen-stats drift**: sparse weights use IDF/avgdl frozen at the last backfill; tokens
  first seen after the freeze enter with `df=1` (maximal IDF) until refresh. Refresh =
  re-run `build_sparse_keyword.py` with the worker idle. Never affects promote/withdraw
  correctness.
- **Eval baselines must be re-measured fresh** — cite precision drifted from the Phase 1
  reference (.2442 → .1943) as the corpus changed; historical numbers are not gates.
- **3 documents labeled `zh` have English extracted text** (external ids 3778, 5852, 2130)
  — flagged for the language-ID workstream.
- **Plain-text task-definition env secrets** (the three secret JSONs become `environment`
  entries; SSM Parameter Store deferred).
- **No terraform plan-only gate and no migration step in CI/CD** — first real plan happens
  inside the deploy's apply job; schema changes are manual per the runbook.

## Evidence summary

- **Review coverage**: two full multi-agent review waves, each followed by fix commits
  (wave 1 across Phases 0–2: security/correctness/UI/worker-lifecycle; wave 2 across the
  sparse lane + app tier + eval harness).
- **Sparse-lane eval gate — PASS, exact** (design note §10.3): `eval:cite` 11/11 queries
  identical retrieved-URL lists vs same-day baseline (P .1943 / R .8701 / F1 .3039 both);
  `eval:answer-retrieval` aggregates identical (chunk F1 .357, adjacent F1 .465, doc F1
  .871); es/pt smoke 9/9 at rank 1 both lanes; construction parity 26/26 queries SQL-vs-bm25s
  (max score diff 9.5e-7); withdraw/promote consistency instant in both directions.
- **Tests**: Jest 132 tests / 16 suites (≈33 DB-gated); Python 98 tests / 11 files.
  CI (`pr-check.yml`) runs Jest unit + 7 hermetic/scratch-DB Python modules against a
  pgvector service container with `REQUIRE_DB_TESTS=1`; corpus-dependent suites remain
  local-only (see [phase0-cutover.md § What CI runs](../runbooks/phase0-cutover.md#what-ci-runs)).
