# Local testing guide

How to test the full AskWRI stack on a laptop, with no AWS access. Covers what
each AWS dependency is replaced by locally, the test commands in
cheapest-first order, and the few things that genuinely cannot be tested
without a deploy.

> **Multilingual-v3 update (2026-07-22): "no AWS access" no longer covers
> dense retrieval.** The local qa DB corpus is all `cohere-embed-v4` and the
> dense lane + rerank are Bedrock API calls — live queries need AWS creds
> (`aws login`; for long-running processes use the boto3 `login` provider
> via `botocore[crt]`, see `docs/runbooks/bedrock-local-testing.md` Step 2).
> Without creds the service now degrades: rerank falls back to fused,
> dense falls back to sparse-only (`/health` reports `dense_lane`).
> Unit/integration test suites remain fully offline (Bedrock is stubbed).
>
> **Creds footgun (bit twice — 2026-07-22 worker, 2026-07-26 probes):**
> `search-service/.env.local` carries MinIO placeholder `AWS_ACCESS_KEY_ID`/
> `AWS_SECRET_ACCESS_KEY` for the S3 lane, and `app/env.py` loads them into
> the process env — boto3 then uses them for **Bedrock** too and every dense
> call fails `UnrecognizedClientException`. Because the dense lane degrades
> gracefully, `/query` still returns 200 — a passing curl is NOT proof the
> dense lane ran; check the service log or `/health`. Fix: start the service
> from a shell with real creds exported (they take precedence over
> `.env.local`): `eval "$(aws configure export-credentials --format env)"`
> then `./venv/bin/python -m app.main`.

Companions: `docs/runbooks/phase0-cutover.md` (initial local setup — docker
Postgres, venv, data load) and `docs/runbooks/qa-push-deploy.md` (the deploy
side). This guide assumes the cutover setup is done.

---

## 0. Bootstrap (one command)

```bash
./scripts/local-bootstrap.sh
```

Idempotent; safe after a reboot, docker wipe, or fresh worktree. Stands up
docker Postgres (pgvector) + MinIO (`docker-compose.local.yml`), writes the
gitignored env files (`.env.local`, `.env.test.local`,
`search-service/.env.local` — only if absent), runs migrations, loads the
169-doc corpus from the warm cache (no OpenAI cost), backfills the sparse
keyword lane, seeds the MinIO bucket, and creates the admin user (`admin` /
`admin-local-password`).

Prereqs it checks for you: docker, `search-service/venv`, and a complete
`search-service/data` (169 PDFs + `documents.csv` + cache). It refuses to run
with a partial corpus.

Env-file precedence (all loaders): real env > `.env.local` > `.env`. Jest is
the exception to _which file_: `NODE_ENV=test` skips `.env.local`, so Jest
reads `.env.test.local`. Deploy-day commands
(`DATABASE_URL=... npm run migration:run`) are unaffected — explicit env
always wins. The deploy-day `.env` is never touched.

---

## 1. AWS dependency → local substitute

| AWS service                         | Local substitute                                                           | How                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| RDS Postgres                        | docker container `askwri-pg`, db `qa`                                      | `DATABASE_URL=postgresql://askwri:password@localhost:5432/qa` in both `.env.local` and `search-service/.env.local` (bootstrap-written) |
| S3 documents bucket                 | MinIO container `askwri-minio` (bucket `askwri-data`, seeded by bootstrap) | `AWS_ENDPOINT_URL=http://localhost:9000` in the `.env.local` files; local-dir fallback still available via `DOCUMENTS_LOCAL_DIR`       |
| S3 intake drop                      | MinIO `intake/` prefix (the real S3 code path)                             | leave `INTAKE_LOCAL_DIR` unset; the worker sweeps MinIO. Legacy local-dir mode: set `INTAKE_LOCAL_DIR`                                 |
| ECS Fargate (app / search / worker) | run each process directly                                                  | commands below                                                                                                                         |
| Secrets Manager / task-def env      | `.env.local` (app) + `search-service/.env.local` (service & worker)        | note: the search-service reads **`search-service/.env(.local)`**, not the repo-root files                                              |

The one real external dependency is **OpenAI** (query embeddings; worker
metadata extraction, summaries, tagging). `OPENAI_API_KEY` in
`search-service/.env` or `search-service/.env.local` covers it (the bootstrap
does not write it).
Postgres state expected: all migrations applied — currently through
`1781340000000` (sparse lane, authors/url/date columns, metadata-provenance
`metadata_source` + key normalization) — and the sparse backfill run (see §7
reset recipes if your db predates this).

Cannot be tested locally (deploy-only surface):

- ECS service discovery, task IAM roles, the GitHub Actions deploy pipeline.
- Secrets Manager JSON plumbing — the local env files stand in for the values;
  the real AWS wiring (rotation, task-def injection) is deploy-only.
- RDS-specific behavior (extension allowlist, SSL). Local docker is PG 16
  with `vector` 0.8.4, matching RDS PG16 for everything this repo uses.

---

## 2. Boot the stack

Three processes, three terminals (or background them):

```bash
# 1. Postgres (if not already running)
docker start askwri-pg

# 2. Search service on :8000  (~15s to ready in sparse mode)
cd search-service && ./venv/bin/python -m app.main
#   NOT `npm run search-service` — broken locally (venv has no pip shim).
#   Stop with: npm run search-service:stop

# 3. Web app on :3000
npm run dev
```

Readiness check — also confirms which backends are active:

```bash
curl -s localhost:8000/health
# expect "status":"healthy", "keyword_backend":"sparse", "retrieval_backend":"postgres"
```

Admin UI: `http://localhost:3000/admin`, login `admin` / `admin-local-password`
(re-seed with `ADMIN_PASSWORD=<pw> npm run seed:admin -- <user>`; requires `SESSION_SECRET`
≥ 32 chars in `.env.local` — the bootstrap writes one).

---

## 3. Automated suites (no AWS, ~3 min total)

Run all of these before trusting anything else; they are the same gates CI
and the merge process use:

| Command                    | What it covers                                                                                                | Expected                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `npm test`                 | app tier (Jest, jsdom; DB suites run via `.env.test.local`)                                                   | 33 suites / 260 tests passed, 0 failed |
| `npm run test:db`          | the `*.db.test.ts` suites only, serialized with `--runInBand` (they share the docker pg and race in parallel) | 14 suites / 99 tests                   |
| `npm run test:python`      | search-service + worker; DB-gated suites create **scratch databases** (`askwri_*_test`) and never touch `qa`  | 140 pass, 1 skipped                    |
| `npm run lint`             | eslint                                                                                                        | clean                                  |
| `npx next build --webpack` | prod build (**not** plain `next build` — Turbopack panics on the `search-service/venv` symlink)               | green                                  |

The one expected `test:python` skip is `test_dockerfile_worker.py` — an opt-in
Docker-build test (`REQUIRE_DOCKER_TESTS=1` to enable); leave it skipped. If
_other_ suites skip with a DB-gating warning, `DATABASE_URL` isn't visible —
check `search-service/.env` / `search-service/.env.local`.

If a `*.db.test.ts` suite fails intermittently under plain `npm test` (parallel
workers share the docker pg), re-run via `npm run test:db` — it and CI's
`test:ci` serialize with `--runInBand` to avoid the isolation races.

---

## 4. Retrieval & sparse keyword lane

The 2026-06-11 lane replacement shipped with verification tooling — reuse it
any time retrieval code changes.

**Parity check (~3 min, service not required, read-only):** proves the
Postgres sparse lane is score-identical to the legacy in-memory BM25 on 26
fixed queries (10 golden + 16 non-English):

```bash
cd search-service && ./venv/bin/python -m scripts.sparse_parity_check --db
# expect: 26/26 on RDS pgvector 0.8.2; locally on pgvector 0.8.4 expect ~23/26
# (3 queries differ by one BM25 tie-group — a floating-point precision
# difference between in-memory bm25s and pgvector sparsevec, not a
# correctness regression; retrieval tuning is out of scope for the local-dev
# work), and 26 DB-OK lines
```

**Non-English smoke set (~2 min, service required):** 16 hand-verified
zh/es/pt queries, per-lane target ranks, reranker skipped:

```bash
npx tsx evaluation/run-non-english-smoke.ts --label local
# expect: dense 16/16; BM25 lane 9-11/16 (zh finds 0-2 — known, dense carries zh);
# es/pt 9/9 at rank 1. Results land in evaluation/results/.
```

**Lifecycle consistency (30 seconds, the whole point of the sparse lane):**

```bash
docker exec askwri-pg psql -U askwri -d qa -c \
  "UPDATE documents SET status='withdrawn' WHERE external_id='2022_guia-de-entornos-caminables-seguros_2940'"
curl -s -X POST localhost:8000/query -H "Content-Type: application/json" \
  -d '{"query": "entornos caminables seguros", "mode": "cite", "rerank": false, "return_intermediate_results": true}'
# expect: doc absent from bm25_results, vector_results, and docs — immediately, no reindex
docker exec askwri-pg psql -U askwri -d qa -c \
  "UPDATE documents SET status='searchable' WHERE external_id='2022_guia-de-entornos-caminables-seguros_2940'"
# re-query: doc back at BM25 doc-rank 1 immediately
```

The same check works through the admin UI (withdraw/restore buttons on a
document page) — no staleness warnings should appear anywhere.

**Full eval suite (~70 min, detached, when you need numbers):**

```bash
npm run eval:baseline-suite -- <label>     # e.g. "local-2026-06-12"
tail -f evaluation/results/baseline-suite-<label>.log
```

Runs cite eval (11 q) → answer eval (9 q) → smoke set → `/reindex` timing.
Detaches from your terminal (survives closing it), checkpoints per query
(re-run the same command to resume after any interruption), refuses to start
if another suite run is active. Reference baselines to compare against:
`docs/plans/2026-06-11-keyword-lane-replacement-design-note.md` §4 and §10.3.
Caveat: local cite queries take ~3 min each (CPU reranker) — don't run other
heavy work on the machine during a suite if you care about the latency numbers.

---

## 5. Ingestion worker end-to-end

Exercises the full pipeline: intake → parse (text + LLM metadata extraction)
→ language → summarize → classify → embed (dense + sparse vectors) → publish.
Costs a few cents of OpenAI per document (metadata + summaries + tagging).

Two intake modes:

**S3/MinIO intake (default — the real deploy code path).** Leave
`INTAKE_LOCAL_DIR` unset; the worker sweeps the MinIO `intake/` prefix. Drop
a PDF through the admin upload page (`/admin/upload`, drag-and-drop → MinIO)
or straight into the bucket, then start the worker:

```bash
cd search-service && ./venv/bin/python -m scripts.make_canary_pdf  # unique test PDF
# upload it at http://localhost:3000/admin/upload, then:
./venv/bin/python -m worker.main
```

Use `scripts.make_canary_pdf` for test files — re-dropping identical bytes is
deduped by `content_hash` and silently skipped.

**Legacy local-dir intake** (no MinIO involved):

```bash
mkdir -p search-service/intake
# add to search-service/.env.local:  INTAKE_LOCAL_DIR=./intake
cp ~/some-paper.pdf search-service/intake/
cd search-service && ./venv/bin/python -m worker.main
```

Watch progress:

```bash
docker exec askwri-pg psql -U askwri -d qa -c \
  "SELECT stage, status, attempts, last_error FROM ingestion_jobs ORDER BY created_at DESC LIMIT 5"
```

Verify the published doc end-to-end:

- `documents.status = 'needs_review'` — since issue #310 the worker never
  auto-publishes a new document; it appears in `/admin/review` for promotion
  regardless of extraction confidence. (Only a RE-ingested doc that was
  already `searchable` comes back as `searchable`.)
- Metadata extracted by the parse stage: `title`, `authors`, `doi`,
  `year_published`, `article_type`, `wri_primary_office` populated with
  `metadata_source->>'<field>' = 'llm'` provenance. The extraction is
  best-effort (a failed LLM call logs a warning and the stage continues) and
  provenance-guarded: it only writes fields whose source is NULL or `'llm'` —
  CSV-imported (`'external'`) and human-edited (`'human'`) values are never
  overwritten; a prior LLM value IS overwritten on re-ingest.
- Its chunks have BOTH `embedding` and `sparse` populated:
  `SELECT count(*) FILTER (WHERE sparse IS NOT NULL), count(*) FROM document_chunks dc JOIN documents d ON d.id=dc.document_id WHERE d.external_id='<id>'`
- A distinctive phrase from the PDF finds it via `/query` (both lanes — use
  `"rerank": false, "return_intermediate_results": true` and check
  `bm25_results` + `vector_results`).
- New-doc passage context: the worker POSTs `/reindex` after publish to
  refresh the service's in-memory texts; if the service wasn't running during
  publish, restart it (or POST `/reindex` yourself) before checking passages.

Note: a doc ingested while `keyword_corpus_stats` is empty (backfill never
run) gets `sparse = NULL` and is keyword-lane-dark until the next backfill —
the worker logs a warning when this happens.

---

## 6. Admin lane checks

All of these run against the local stack (§2) at `http://localhost:3000/admin`.

**Upload page + worker status (`/admin/upload`).** Drag-and-drop PDFs land in
the MinIO `intake/` prefix (the real S3 code path). The status pill is derived
from DB + S3 state, no heartbeat: `processing` (open jobs), `pending` (intake
file dropped < ~20 s ago — the worker just hasn't polled yet, not an error),
`stale` (intake file older than the threshold with no open job — the worker is
down), `idle` (caught up). To see the full arc, stop the worker, upload a
canary PDF (`pending` → `stale` after ~20 s), then start the worker
(`processing` → `idle`).

**CSV metadata import (`/admin/import`).** Bulk metadata via flat CSV —
download the sample from the "Download CSV template" link
(`/api/admin/import/template`), edit, upload, click **Preview** for a dry-run
(per-row decisions, no writes), then **Apply**. Rows match existing documents
by `external_id` or `doi`; matched fields are overwritten with per-field
warnings and get `metadata_source='external'` provenance, so a later worker
re-ingest never clobbers them. The legacy JSON-blob format is still accepted
(fill-only-empty). Admin-only; writes an `audit_log` row.

**Document lifecycle (document page).** Withdraw/restore as in §4. Hard
delete (admin-only) removes the DB rows and S3 objects and writes an audit
tombstone — verify the doc disappears from `/query` results and `/api/catalog`
immediately.

---

## 7. Reset recipes

**Refresh keyword stats after bulk corpus changes** (never needed for
withdraw/promote correctness — only weight freshness):

```bash
cd search-service && ./venv/bin/python -m scripts.build_sparse_keyword
# ~1 min on 30k chunks; idempotent; single transaction
```

**Db predates the sparse lane** (boot fails with "sparse is unpopulated"):

```bash
npm run migration:run                                  # applies all pending (sparse lane = 1781310000000)
cd search-service && ./venv/bin/python -m scripts.build_sparse_keyword
```

**Fall back to the legacy in-memory lane** (e.g. to reproduce old behavior):
set `KEYWORD_BACKEND=memory` in `search-service/.env` and restart. Withdraw/
promote then require a manual `POST /reindex` again — that staleness is the
legacy behavior, not a bug.

**Clear eval checkpoints** (forcing a from-scratch eval run): delete
`evaluation/results/cite-eval-checkpoint.json` and the relevant
`baseline-suite-<label>.state`.

---

## 8. Known local gotchas

- **Turbopack panics** on the `search-service/venv` symlink → always
  `npx next build --webpack` locally. CI/Docker unaffected.
- **`npm run search-service` is broken** (venv lacks pip) → run
  `./venv/bin/python -m app.main` directly.
- **Long-lived service may hit OpenAI `431 Request headers are too large`**
  on embedding calls (Cloudflare cookie accumulation in the shared httpx
  client). Transient — retry the query or restart the service. Eval
  checkpointing means a rerun only re-pays the failed query.
- **Don't run two eval suites at once** — the suite runner enforces a lock
  (`evaluation/results/.suite-lock`); if a run died hard, `rmdir` that
  directory before restarting.
- **`PythonFinalizationError ... ConnectionPool.__del__`** noise at script
  exit (psycopg pool destructor on Python 3.14) is harmless.
- The eval client allows 30-minute responses (local CPU reranking is slow);
  if a script seems hung, it's probably mid-rerank — check the service log
  before killing anything.
- **`docker compose up` can't bind port 5432** → an ambient Homebrew/system
  Postgres may be occupying it. Stop it (`brew services stop postgresql@15` on
  macOS; reversible via `brew services start postgresql@15`) so the bootstrap's
  `askwri-pg` container can bind `127.0.0.1:5432`.
- **Node `>=24` is pinned in `package.json` engines but unenforced** — v23.10
  works; upgrade at leisure.
- **Corpus migration logs OpenAI embedding calls instead of
  `Loaded ... cached embeddings`** → the cache content-hash missed. One-time
  ~$1 re-embed; let it run, then the cache is warm again.
- **Worker-ingested docs: admin "Open PDF" works, public PDF link 404s until
  the app re-syncs at boot** (the R5 gap, found while building the local dev
  environment, 2026-07-06; deploy-side, tracked in the deploy plan follow-ups).
  Locally this shows up on canary docs and is expected.
- **Worker e2e: use `scripts.make_canary_pdf`** — re-dropping identical
  bytes is deduped by `content_hash` and will be skipped.
