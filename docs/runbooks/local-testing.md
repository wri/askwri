# Local testing guide

How to test the full AskWRI stack on a laptop, with no AWS access. Covers what
each AWS dependency is replaced by locally, the test commands in
cheapest-first order, and the few things that genuinely cannot be tested
without a deploy.

Companions: `docs/runbooks/phase0-cutover.md` (initial local setup — docker
Postgres, venv, data load) and `docs/runbooks/qa-push-deploy.md` (the deploy
side). This guide assumes the cutover setup is done.

---

## 1. AWS dependency → local substitute

| AWS service | Local substitute | How |
|---|---|---|
| RDS Postgres | docker container `askwri-pg`, db `qa` | `DATABASE_URL=postgresql://askwri:password@localhost:5432/qa` in both `.env` and `search-service/.env` |
| S3 documents bucket | local directory | `DOCUMENTS_LOCAL_DIR=./data` in `search-service/.env` |
| S3 intake drop (bulk ingest) | local directory | set `INTAKE_LOCAL_DIR=<dir>` in `search-service/.env`; the worker sweeps it instead of S3 |
| ECS Fargate (app / search / worker) | run each process directly | commands below |
| Secrets Manager / task-def env | `.env` (app) + `search-service/.env` (service & worker) | note: the search-service reads **`search-service/.env`**, not the repo-root `.env` |

The one real external dependency is **OpenAI** (query embeddings; worker
summaries/tagging). `OPENAI_API_KEY` in `search-service/.env` covers it.
Postgres state expected by the sparse keyword lane: migrations through
`1781310000000` applied and the sparse backfill run (see §6 reset recipes if
your db predates this).

Cannot be tested locally (deploy-only surface):

- S3-backed "Open PDF" in the admin UI — degrades to a clean JSON error
  without AWS creds; everything else on the page works.
- ECS service discovery, task IAM roles, the GitHub Actions deploy pipeline.
- RDS-specific behavior (extension allowlist, SSL). Local docker is PG 16
  with `vector` 0.8.2, matching RDS PG16 for everything this repo uses.

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
(re-seed with `npm run seed:admin -- <user> <pw>`; requires `SESSION_SECRET`
≥ 32 chars in `.env`).

---

## 3. Automated suites (no AWS, ~3 min total)

Run all of these before trusting anything else; they are the same gates CI
and the merge process use:

| Command | What it covers | Expected |
|---|---|---|
| `npm test` | app tier (Jest, jsdom; DB suites included locally because `.env` is loaded) | 132 pass |
| `npm run test:db` | TypeORM queries against docker pg | 33 pass |
| `npm run test:python` | search-service + worker; DB-gated suites create **scratch databases** (`askwri_*_test`) and never touch `qa` | 98 pass, 0 skips |
| `npm run lint` | eslint | clean |
| `npx next build --webpack` | prod build (**not** plain `next build` — Turbopack panics on the `search-service/venv` symlink) | green |

If `test:python` reports skips, `DATABASE_URL` isn't visible — check
`search-service/.env`.

---

## 4. Retrieval & sparse keyword lane

The 2026-06-11 lane replacement shipped with verification tooling — reuse it
any time retrieval code changes.

**Parity check (~3 min, service not required, read-only):** proves the
Postgres sparse lane is score-identical to the legacy in-memory BM25 on 26
fixed queries (10 golden + 16 non-English):

```bash
cd search-service && ./venv/bin/python -m scripts.sparse_parity_check --db
# expect: "26/26 queries score-identical" and 26 DB-OK lines
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

## 5. Ingestion worker end-to-end (no S3)

Exercises the full pipeline: intake → parse → language → summarize → classify
→ embed (dense + sparse vectors) → publish. Costs a few cents of OpenAI per
document (summaries + tagging).

```bash
mkdir -p search-service/intake
# add to search-service/.env:  INTAKE_LOCAL_DIR=./intake
cp ~/some-paper.pdf search-service/intake/
cd search-service && ./venv/bin/python -m worker.main
```

Watch progress:

```bash
docker exec askwri-pg psql -U askwri -d qa -c \
  "SELECT stage, status, attempts, last_error FROM ingestion_jobs ORDER BY created_at DESC LIMIT 5"
```

Verify the published doc end-to-end:

- `documents.status = 'searchable'` (or `needs_review` if extraction
  confidence < 0.7 — then it appears in `/admin/review` for promotion).
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

## 6. Reset recipes

**Refresh keyword stats after bulk corpus changes** (never needed for
withdraw/promote correctness — only weight freshness):

```bash
cd search-service && ./venv/bin/python -m scripts.build_sparse_keyword
# ~1 min on 30k chunks; idempotent; single transaction
```

**Db predates the sparse lane** (boot fails with "sparse is unpopulated"):

```bash
npm run migration:run                                  # applies 1781310000000
cd search-service && ./venv/bin/python -m scripts.build_sparse_keyword
```

**Fall back to the legacy in-memory lane** (e.g. to reproduce old behavior):
set `KEYWORD_BACKEND=memory` in `search-service/.env` and restart. Withdraw/
promote then require a manual `POST /reindex` again — that staleness is the
legacy behavior, not a bug.

**Clear eval checkpoints** (forcing a from-scratch eval run): delete
`evaluation/results/cite-eval-checkpoint.json`,
`answer-retrieval-checkpoint.json`, and the relevant
`baseline-suite-<label>.state`.

---

## 7. Known local gotchas

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
