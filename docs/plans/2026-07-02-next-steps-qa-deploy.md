# Next Steps — Ship the Document-Management System to QA (Simplified Guide)

**Date:** 2026-07-02 · **Branch:** `qa-wip-david` (local-only, ~104 commits ahead of `origin/qa`)
**Companion to:** the detailed [QA push plan](2026-07-01-qa-push-plan.md) and the [review findings](2026-07-01-doc-mgmt-review-findings.md).
**Audience:** whoever picks this up next. This doc assumes you're new to the work — start with the "Background" and "Key terms" sections, then follow the steps in order. For exact commands, SQL, and edge cases, follow the links to the detailed docs.

---

## Background — what was built, and why this deploy is unusual

**AskWRI** is a research interface over WRI's published corpus (PDFs and reports). It has three parts:

- **Web app** (Next.js) — public search UI + admin surface.
- **Search service** (FastAPI, Python) — the `/query` hybrid-search endpoint the app calls.
- **Ingestion worker** (Python) — processes new PDF uploads into searchable chunks.

A large body of work — the **document-management system** — has been built across three phases:

- **Phase 0** — store document chunks and their embedding vectors in Postgres (pgvector), and migrate the existing ~169-doc corpus into it.
- **Phase 1** — an ingestion worker that turns new uploads into chunks/embeddings automatically.
- **Phase 2** — an admin UI (documents, review queue, tags, collections, users, audit log).
- Plus a **sparse keyword lane** — the keyword half of hybrid search, now stored in Postgres (was in-memory).

All of this lives on the branch `qa-wip-david`, has been code-reviewed (5-way review + adversarial re-verification), and the deploy-blocking bugs it found are fixed. **None of it has ever been deployed to QA.**

This is the **first time** this work reaches `origin/qa` and deploys, which makes it a bigger deploy than a normal push for three reasons:

1. **CI has no migration step.** Database schema changes are manual, and must be run against the QA database _before_ the deploy — otherwise the new code runs against an unprepared schema.
2. **The new search service refuses to serve queries if the "sparse backfill" hasn't run** — it raises at boot, `/query` returns 500 for everything. The backfill must run first.
3. **One of the migrations is destructive and irreversible** (a no-op _this_ time because the table is empty, but a real hazard if ever re-applied against a live system).

So the **order of the steps below matters.** Don't skip ahead, and don't merge the PR until Steps 1–6 are done.

---

## Key terms (so the rest of this makes sense)

| Term                           | What it means here                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **RDS**                        | AWS-managed Postgres database (the QA one is "the QA RDS").                                                                   |
| **pgvector**                   | A Postgres extension for storing/searching embedding vectors. Must be available on RDS before the schema migration can run.   |
| **migration**                  | A script that changes the database schema. This work has 4 pending ones (`178128`–`178131`).                                  |
| **`/query`**                   | The hybrid-search endpoint (keyword + vector) the public app relies on. If it 500s, search is down.                           |
| **sparse keyword lane / BM25** | The keyword-search half of `/query`. It now needs precomputed "sparse vectors" stored in Postgres.                            |
| **sparse backfill**            | The script that precomputes and stores those sparse vectors. **Must run before the new search service boots in sparse mode.** |
| **corpus**                     | The full set of WRI documents being migrated (~169 docs, ~30k chunks).                                                        |
| **ECS**                        | AWS service that runs the three containers (app, search service, worker).                                                     |
| **pr-check / CI**              | Automated tests GitHub runs on a pull request (Jest tests, build, Python DB tests, docker build, terraform validate).         |
| **dependabot bumps**           | Routine dependency-version updates (already merged in; not something you need to do).                                         |

---

## What's already done ✅ (no action needed)

Three "deploy blockers" and one user-visible regression were found in review and are **fixed and tested**:

- **B1** — the ingestion worker's Docker image now includes its `worker/` code (it was crash-looping).
- **B2** — IAM now permits browser intake uploads to `intake/` (they were 403ing in prod).
- **B3** — the search service now tolerates unknown env vars (it was crashing at boot on any undeclared var).
- **R1** — public PDF links keep working after the Postgres cutover (the S3 documents sync was being skipped).

Tests covering all four are in. The July 1 dependency updates are merged and the build was re-verified.

---

## Decide these first (5 min)

1. **Push as a PR or directly to `qa`?** → A PR is recommended: it runs the full test matrix (including the Python database tests) and gives a review checkpoint before the deploy fires. Confirm with the team that a PR is the intended path.
2. **Sparse or memory on first boot?** → `sparse` is the new default, but it requires the sparse backfill (Step 4) to have run first. If database access is delayed, use `memory` as a fallback (the old in-memory keyword path) and flip to sparse later.
3. **Pick a quiet QA window.** Budget **~1 hour+** end-to-end. The corpus migration (Step 3) is the expensive part.

---

## Part 1 — Ship the first QA deploy safely

> **Golden rule:** do NOT merge the PR (Step 7) until Steps 1–6 are done. Otherwise the deploy boots a search service that returns 500 on every query.

### Step 1 — Database preflight _(needs AWS access — gates everything)_

Confirm the QA RDS instance has the `vector` extension available (version ≥ 0.7.0). The first migration opens with `CREATE EXTENSION … vector`; if the extension isn't available, that statement fails. If it's unavailable, do a minor RDS engine upgrade first (via the AWS console — this RDS instance is managed outside this repo's Terraform).

- Also confirm all 4 migrations show as pending: `npm run migration:show`.
- Detail: [push plan §B0](2026-07-01-qa-push-plan.md), [phase0-cutover.md Step 1](../runbooks/phase0-cutover.md).

### Step 2 — Run the 4 migrations against the QA database _(quiet window)_

`DATABASE_URL="postgresql://…?sslmode=require" DATABASE_SSL=true npm run migration:run`

- `178128` (creates the 11 tables + extensions) → `178129` (adds a `corpus_order` column for search ranking) → `178130` (dedupes open jobs — **a no-op this time**, the table is empty) → `178131` (creates the sparse-keyword tables, needed before Step 4).
- Detail: [push plan §B1](2026-07-01-qa-push-plan.md).

### Step 3 — Migrate the full corpus into the database _(the expensive step)_

Copy the S3 documents **and** the warm cache to a local `/tmp` folder, then run the migration script.

- `cd search-service && DATABASE_URL="…" ./venv/bin/python -m scripts.migrate_csv_to_postgres` → expect `Done: 169 documents, <N> chunks.`
- **Why the warm cache matters:** cold = re-embed ~30k chunks via OpenAI (costs ~$1 and takes minutes); warm = zero OpenAI calls and is fast.
- ⚠️ **Do NOT use the `--reset` flag** on a live database — it wipes tables in a way that also destroys in-flight worker jobs (review finding D6). On a fresh database you don't need it anyway.
- Verify the result with the SQL in the runbook: expect `docs=169, searchable=169, texts=169, missing_embeddings=0`. Detail: [phase0-cutover.md Steps 3–4](../runbooks/phase0-cutover.md).

### Step 4 — Sparse keyword backfill _(must run before any sparse-mode boot)_

`cd search-service && DATABASE_URL="…" ./venv/bin/python -m scripts.build_sparse_keyword`

- Expect `vocab 184395; avgdl ~192` (~1–2 minutes, idempotent). This populates the sparse vectors the new search service needs at boot.
- Detail: [push plan §B3](2026-07-01-qa-push-plan.md).

### Step 5 — Parity + evaluation gate _(strongly recommended before merge)_

Because the corpus is being written for the first time, this is the last chance to catch a bad migration _before_ users see it. Start the search service in `postgres` mode on port 8001 next to the legacy one on 8000, run the parity comparison script, then run the two eval suites (`npm run eval:cite` + `npm run eval:answer-retrieval`). Acceptance: citation precision/F1 within ±1 of legacy; answer precision/recall/F1 within ±2. If it fails, do **not** merge — fix and re-run Steps 3–5.

- Detail: [push plan §B4](2026-07-01-qa-push-plan.md), [phase0-cutover.md Step 5](../runbooks/phase0-cutover.md).

### Step 6 — GitHub secrets _(needs GitHub admin access)_

- **Create a new secret `INGESTION_WORKER_ENV`** = JSON like `{"DATABASE_URL":"…","OPENAI_API_KEY":"…"}`. Without it the worker boots with no database/OpenAI and crash-loops.
- **Add `SESSION_SECRET`** (≥32 chars; generate with `openssl rand -hex 32`) to the existing `ASKWRI_APP_ENV` secret JSON. Without it, admin login fails (every `/admin` request 401s).
- **Verify `SEARCH_SERVICE_ENV`** contains `DATABASE_URL` and `RETRIEVAL_BACKEND=postgres`. Set `KEYWORD_BACKEND=sparse` (if Step 4 ran) or `memory` (fallback).
- Detail: [push plan §C](2026-07-01-qa-push-plan.md).

### Step 7 — Push, open PR, merge _(triggers the deploy)_

1. `git push origin qa-wip-david` (updates the remote branch only — triggers nothing).
2. `gh pr create --base qa --head qa-wip-david`. Wait for `pr-check.yml` to go green (Jest + build + 7 Python DB tests + docker build + terraform validate). **Eyeball the docker-build job output** — it's the only CI signal that the images actually build.
3. **Merge at a chosen time.** Merging pushes to `qa`, which triggers the deploy: build both images → `terraform apply` (creates the new ingestion-worker service, IAM, and security groups) → force a new deployment of all 3 services → wait for them to stabilize.
   - ⚠️ While the deploy runs, **watch the terraform plan output** in the Actions log (there's no separate plan-only gate). Confirm the new ingestion-worker service and IAM are being _added_, and that nothing unexpected is being destroyed.

- Detail: [push plan §D](2026-07-01-qa-push-plan.md), [qa-push-deploy.md](../runbooks/qa-push-deploy.md).

### Step 8 — Verify after deploy _(needs ECS access)_

- Seed an admin user: `npm run seed:admin -- <user> <password>` (clear your shell history afterward — the password is visible).
- From inside a running task, check `/health` → expect `status: healthy`, `keyword_backend: sparse`, `retrieval_backend: postgres`. Those two `*_backend` fields are new — if they're absent, an old image is still running.
- Smoke-test `/query` → expect 200 with results. Open the web UI: public search works; `/admin` login works; `/admin/review` and `/admin/documents` render. Check the worker logs — no crash-loop. Make one admin change, then confirm a fresh row appears in `audit_log`.
- Detail: [push plan §E](2026-07-01-qa-push-plan.md).

---

## Part 2 — Follow-up work (non-blocking, after the deploy)

These came out of the code review. **None of them block the first push.** Priorities and owners are suggested below; full detail (file:line, reasoning) is in the [findings doc](2026-07-01-doc-mgmt-review-findings.md).

### 🔴 Do first (security + silent correctness)

- [ ] **D3 — Unvalidated import `s3_key` (security).** When a document is imported via CSV, the `s3_key` field isn't validated. Any logged-in user can point it at an object in a different S3 prefix (e.g. `eval-data/secret.pdf`) and either download it or have the worker ingest it — at which point the content becomes searchable and can surface to public users. Validate `s3_key` on import; sanitize the S3 download key. **Highest priority.**
- [ ] **R3 — Worker builds chunks differently from the original migration (silent ranking drift).** The worker's chunk builder diverges from the Phase-0 builder in three metadata fields (title source, authors truncation, `file_path` vs `s3_key`), and it has **zero test coverage**. Result: chunks the worker produces get different keyword-search rankings than migrated ones. Reconcile both paths onto one shared builder and add a metadata-parity test.
- [ ] **R4 — Chinese page numbers can be misattributed.** Text is normalized Traditional→Simplified, but page boundaries are computed from the original text; a length-changing phrase shifts later chunks' computed page numbers. Recompute boundaries on the normalized text and add a multi-page Chinese test asserting `page` values.

### 🟠 Data integrity (small follow-up PR)

- [ ] **D1** — The `IngestionJob` entity annotation says `onDelete:'SET NULL'` but the migration set `CASCADE`. Fix the annotation, or `npm run migration:generate` will emit a spurious migration that silently reverts the cascade.
- [ ] **D2** — The import "open statuses" list wrongly includes `needs_review`, and the insert isn't atomic — two concurrent imports of the same document race and one throws a 500. Drop `needs_review`; use the atomic `ON CONFLICT … DO NOTHING` pattern already used elsewhere.
- [ ] **D4** — Mutations and their audit-log rows are written as separate statements; if the audit write throws, the mutation commits un-audited. Wrap each pair in a transaction.
- [ ] **D5** — Bulk import doesn't record _who_ did it in the audit log. Pass the acting user's identity into the import function.

### 🟡 Verify / harden (latent — not live-broken as currently deployed)

- [ ] **R2** — The worker never sets up custom SSL certificates (a VPN workaround). It's dormant because the relevant flag isn't set in prod. **Verify before enabling that flag for the worker**; wire it shared if needed.
- [ ] **D6** — The migration script's `--reset` flag silently wipes in-flight worker jobs via a database cascade. Document this loudly, or scope the wipe to only the tables the script owns.
- [ ] **D7** — One migration deletes rows with no code-level guard. Add a row-count assertion (no-op this push, but protects future re-applies).
- [ ] **R5 — Public PDF links 404 for worker-ingested docs until app restart.** `start-app.sh`
      syncs S3→`/tmp/askWRI_docs` once at boot; a doc published later gets working search and
      admin Open PDF but a 404 public link. Confirm on QA after the first worker ingest; fix
      candidates: periodic re-sync, or serve `/api/pdf/` from S3 with local-dir fallback.
      (Found while building the local dev environment, 2026-07-06.)

### 🟢 Provenance + tests + docs (cleanup)

- [ ] **P1** — `title_en` is NULL for all 33 migrated non-English documents. Either set it to the native title for migrated docs, or document the deferral explicitly.
- [ ] **P2** — The `bahasa`→`id` language mapping differs between the migration script and the import API (intentional and documented) — reconcile them or record the decision.
- [ ] **T1** — Several "parity" claims (e.g. "26/26 results identical") aren't actually enforced by CI — they were verified by hand. Add the relevant Python tests to pr-check; add an automated full-corpus parity test; add a URL-list assertion to the citation eval.
- [ ] **T2** — The chunk ordering that determines search tie-breaks isn't pinned by any test. Add a test asserting the order matches the documented expectation on a small synthetic corpus.
- [ ] **Doc bugs (4):** (a) the as-built doc understates how quickly deactivating a user takes effect — it's near-immediate via DB revalidation, not "up to 7 days"; (b) the runbook's `seed-admin` note wrongly says it won't overwrite an existing user — it actually force-resets them; (c) the doc overstates that worker chunking is identical to the migration (see R3); (d) `CLAUDE.md`'s "one owner per table" rule is stale — the worker now writes several tables, managed by precedence rules.
- [ ] **CI follow-up:** add the opt-in Docker test that catches a missing `worker/` copy (the B1 bug) to pr-check, so it's caught in CI rather than only at deploy time.

---

## If something breaks — rollback (per layer)

| What broke                                    | What to do                                                                                                                                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sparse keyword lane (bad rankings / boot 500) | Set `KEYWORD_BACKEND=memory` in `SEARCH_SERVICE_ENV` and redeploy. The old in-memory keyword path takes over.                                                                                                                                  |
| Bad migration                                 | `npm run migration:revert` (runs one at a time: `178131`→`178130`→…). Note: `178130`'s revert can't restore deleted rows, and reverting `178128`/`178129` **drops the corpus you just migrated** — prefer the env-flag rollback below instead. |
| Bad image / bad code                          | Re-point the `:latest` image tag at the last known-good `:sha` and force a new deployment, or `git revert` + push (rebuilds/redeploys through the pipeline).                                                                                   |
| Whole deploy                                  | Set `KEYWORD_BACKEND=memory` + `RETRIEVAL_BACKEND=legacy` in `SEARCH_SERVICE_ENV`, unset `CATALOG_SOURCE=postgres` in `ASKWRI_APP_ENV`, and redeploy. The search service reverts to its old CSV+S3 boot path.                                  |

> **Realistic rollback is the env-flag flip, not a schema revert** — reverting the schema drops the corpus, which took real time and money to migrate.

Full rollback detail: [push plan §6](2026-07-01-qa-push-plan.md), [qa-push-deploy.md Step 8](../runbooks/qa-push-deploy.md).

---

## Where to find the detail

| If you need…                                                             | Read                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| Exact commands, blast radius, per-step rollback                          | [QA push plan](2026-07-01-qa-push-plan.md) (Phases A–E)   |
| Every finding, with file:line references and adversarial re-verification | [Review findings](2026-07-01-doc-mgmt-review-findings.md) |
| Database cutover, the migration script, verification SQL                 | [phase0-cutover.md](../runbooks/phase0-cutover.md)        |
| Push ordering, migrations, sparse backfill, rollback                     | [qa-push-deploy.md](../runbooks/qa-push-deploy.md)        |
| How to test locally without AWS                                          | [local-testing.md](../runbooks/local-testing.md)          |
