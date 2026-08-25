# Push Plan — Document Management System to QA (first deploy)

**Status:** PLAN — analysis and ordered steps. Nothing below has been executed. Written
2026-07-01 after the code-review + B1/B2/R1 fixes + tests landed on `qa-wip-david`, then
**revised after confirming Phase 0 has NEVER run against the QA RDS** — that makes this the
full first-time cutover (the big path), not the small two-migration path. The small-path
branch is removed below; this is the actual plan.
**Author's intent:** this is the first time *any* of the document-management work
(Phases 0–2 + sparse keyword lane) reaches `origin/qa` and deploys. It is a much bigger
deploy than a normal dependabot push, and the deploy workflow has no migration step and no
plan-only terraform gate — so the ordering below is load-bearing. Read §2 (why this is
different) and §3 (the confirmed scope) before touching anything.

---

## 1. Current state (verified 2026-07-01)

- **Branch:** `qa-wip-david`, local-only (not pushed). After the Phase A merge of
  `origin/qa` + the B3 fix, the deploy-unblocking commits are:
  - `f091d4a` docs: review findings
  - `bbdc97d` fix(iam): PutObject on intake/* (B2)
  - `7b0707c` fix(pdf): keep documents sync in postgres mode (R1)
  - `07555d6` fix(worker): COPY worker/ into Docker image (B1)
  - `91bf7b6` test: cover B1/B2/R1 regressions
  - `ea64bfa` docs: QA push plan (big-path cutover)
  - `ebd07a5` merge: integrate origin/qa dependabot bumps (next 16.2.10, pg 8.22, chakra 3.36, postcss, eslint)
  - `d4c717e` build: update next-env.d.ts route types for next 16.2.10
  - `5a5d3a4` fix(config): ignore undeclared env vars so boot doesn't crash (B3) — surfaced by running the pr-check matrix locally; CI was blind to it (.env gitignored)
- **All three deploy blockers (B1/B2/B3) + the R1 regression are fixed and tested.**
- **Divergence from `origin/qa`:** merge base `e8e77e8` (June 3 react-upgrade).
  - `qa-wip-david` is **100 commits ahead** of `origin/qa` (the entire doc-mgmt system + the Phase A merge).
  - `origin/qa` is **10 commits ahead** of `qa-wip-david` — all dependabot bumps from
    July 1, touching **only `package-lock.json`**: `next 16.2.6→16.2.10`, `pg 8.21→8.22`,
    `@chakra-ui/react 3.35→3.36`, `postcss 8.5.15→8.5.16`, `@typescript-eslint/eslint-plugin
    8.59.2→8.62.1`. **Already merged into `qa-wip-david` (Phase A, commit `ebd07a5`).**
  - `git merge-tree --write-tree origin/qa qa-wip-david` → **exit 0, no conflicts**. The
    integration is mechanically clean (package-lock only).
- **Never deployed:** the ingestion-worker ECS service, the admin surface, the 4 schema
  migrations, the sparse keyword lane, and the new IAM/security-groups are all **first-time**
  on this push. The current `origin/qa` deploy has none of it.

## 2. Why this push is different (the 3 load-bearing hazards)

1. **No migration step in CI.** `deploy-qa.yml` runs test → build 2 images → `terraform
   plan` + `terraform apply -auto-approve` (one job, no plan-only gate) → force-new-deployment
   of all **3** services → `aws ecs wait services-stable`. Schema changes are **manual**,
   per `qa-push-deploy.md`. If we push before migrating RDS, the new code runs against an
   unprepared schema.
2. **Sparse boot guard bricks `/query` if the backfill hasn't run.** The new search-service
   defaults to `KEYWORD_BACKEND=sparse`. At boot, if zero searchable chunks have a populated
   `document_chunks.sparse`, it raises; `/health` reports `degraded - indexing error` and
   every `/query` returns 500 (`Service not properly initialized`). The sparse backfill
   (`build_sparse_keyword.py`) MUST run against RDS before the new search-service boots, and
   it needs migration `1781310000000` (`keyword_vocab`/`keyword_corpus_stats`) first.
3. **Migration `1781300000000` is destructive and irreversible.** Its `up` deletes duplicate
   open `ingestion_jobs` rows before creating a unique index; its `down` restores the FK + drops
   the index but **cannot restore the deleted rows**. Run it in a quiet window. (On the first
   push the table is empty, so it's a no-op — but the hazard is real if re-applied later.)

## 3. Confirmed scope — the big path (full first-time cutover)

**Confirmed 2026-07-01: Phase 0 has never run against the QA RDS.** All four migrations are
pending and none of the doc-management tables (`documents`, `document_chunks`,
`document_texts`, `document_summaries`, `tags`, `document_tags`, `collections`,
`document_collections`, `ingestion_jobs`, `users`, `audit_log`) exist on the QA RDS yet; it
still holds only the legacy query-logs/feedback tables. So Phase B is a **full first-time
cutover of the schema AND the entire 169-doc corpus** — not "run two migrations."

The four migrations in play:

| Migration | What it does | Notes for this push |
|---|---|---|
| `1781280000000` | 11-table pgvector schema (opens with `CREATE EXTENSION IF NOT EXISTS vector` + `uuid-ossp`) | **first statement requires the `vector` extension available on RDS** → B0 preflight is mandatory, not optional |
| `1781290000000` | `document_chunks.corpus_order` column + index (BM25 tie-break parity) | runs with 178128 |
| `1781300000000` | open-job dedupe + unique index + FK→CASCADE (destructive, irreversible `down`) | **no-op this time** — `ingestion_jobs` is empty (worker has never run); the one silver lining of never having run Phase 0 |
| `1781310000000` | `keyword_vocab` + `keyword_corpus_stats` (sparse lane) | required before the sparse backfill (B3) |

**This makes the cutover (Phase B), not the deploy (Phases C/D/E), the risky part.** Budget
~1 hour+ of focused ops in a quiet window: ~1–2 min for B1, ~10–30 min for B2 (warm cache)
or longer + ~$1 OpenAI cost (cold), ~1–2 min for B3, plus the parity/eval gate (~minutes per
query × 11 cite + 9 answer). The push/PR/deploy sequence (C/D/E) is the same as in the small
path; B is where the time, cost, and irreversibility concentrate.

**Rollback reality on the big path:** reverting `178128/178129` drops the new tables and,
via CASCADE, the chunks you just migrated — so "schema rollback" = "lose the cutover." The
realistic rollback if the postgres backend is bad is the **env-flag flip**
(`RETRIEVAL_BACKEND=legacy`, `KEYWORD_BACKEND=memory`, unset `CATALOG_SOURCE=postgres`): the
old code path is intact and reverts to CSV+S3 boot. Do not plan on migrate-then-revert-schema;
plan on env-flag rollback.

## 4. Push strategy — recommended: PR, not direct push to `qa`

Two ways to get the work onto `origin/qa`:

| Path | Steps | Gates before deploy | Risk |
|---|---|---|---|
| **A. PR (recommended)** | push `qa-wip-david` → open PR `qa-wip-david → qa` → review → merge | `pr-check.yml` runs on the PR: Jest `test:ci` + `npm run build`; **7 DB-gated Python modules** against a `pgvector/pgvector:pg16` service container with `REQUIRE_DB_TESTS=1` (incl. `test_worker_queue`, `test_worker_stages`, `test_migration_script`, `test_build_sparse_script`); docker build of **both** images; `terraform fmt -check` + `validate`. Merging the PR pushes to `qa` and triggers `deploy-qa.yml`. | Review + CI gate before deploy. Slower. |
| **B. Direct** | locally merge `origin/qa` into `qa` (or `qa-wip-david`→`qa`), `git push origin qa` | None — `deploy-qa.yml` runs its own `test`+`build` job, but no PR review, no Python DB tests, no terraform validate-before-plan | Faster, less gated. |

**Recommendation: Path A.** The PR runs the real test matrix (including the scratch-DB
worker/sparse/migration tests) before the deploy fires, and gives a review checkpoint.
The only thing pr-check does NOT catch is the B1 runtime failure (`docker-build` builds the
image but does not `import worker.main` — that's caught only by `deploy-qa.yml`'s
`services-stable` wait). The opt-in B1 Docker test (`REQUIRE_DOCKER_TESTS=1`) is **not** in
pr-check; consider adding it to the python-tests or docker-build job as a follow-up (out of
scope for this push, but flagged).

> Note: `qa-wip-david` is a personal branch. PR target is `qa`. Confirm with the team that a
> PR is the intended review path (vs. them wanting the work on a `wri/`-owned branch first).

## 5. Ordered steps

Each step: **what**, **command**, **who**, **blast radius**, **rollback**.
**Who:** "you" = the operator (David) with AWS/GitHub access; "pi" = I can do it from this
machine without credentials.

### Phase A — Local integration (pi can do; no credentials)

**A1. Fetch and confirm divergence is still just package-lock.**
- `git fetch origin`; re-run `git log --oneline qa-wip-david..origin/qa`. Expect the same 10
  dependabot commits. If `origin/qa` moved further, re-check `merge-tree` for conflicts.
- *Blast radius:* none (read-only). *Rollback:* n/a.

**A2. Merge `origin/qa` into `qa-wip-david` locally (or rebase).**
- `git checkout qa-wip-david && git merge origin/qa --no-ff`. Expect a clean merge touching
  only `package-lock.json`.
- *Blast radius:* a bad merge could wedge the branch. *Rollback:* `git merge --abort`, or
  `git reset --hard 91bf7b6` (current tip before merge) — the 5 commits are safe.

**A3. Re-verify after the dep bumps (the bumps include `next 16.2.6→16.2.10`).**
- `npm ci` (fresh install from updated lockfile).
- `npx jest --testPathIgnorePatterns=node_modules --testPathIgnorePatterns=.next --testPathIgnorePatterns=.claude` → expect 10+ suites pass, 6 DB-gated skip, 0 fail.
- `npm run build` → expect success. **Caveat:** locally `next build` (Turbopack) can panic on
  the `search-service/venv` symlink (per `CLAUDE.md`); if it does, use `npx next build
  --webpack`. CI uses a fresh checkout (no venv symlink) so this is a local-only false alarm.
- `cd search-service && ./venv/bin/pip install -r requirements.txt -r requirements-dev.txt && ./venv/bin/python -m pytest tests/ -q` → expect 25+ passed (incl. the new R1/B2 tests), 82 skipped (DB-gated), 0 fail.
- *Blast radius:* a real build/test break from a dep bump. *Rollback:* `git reset --hard 91bf7b6`, investigate.

**A4. Commit the merge** (if A2 produced a merge commit). Do not push yet.

### Phase B — RDS cutover (you; AWS credentials required — THE BIG PATH)

> This is the risky part of this push. Nothing here has ever run against the QA RDS. Do B0
> first; it gates everything.

**B0. RDS engine + extension preflight.** (you)
- `SELECT version();` and `SELECT name, default_version, installed_version FROM
  pg_available_extensions WHERE name IN ('vector','uuid-ossp');`
- Requirement: `vector` available at ≥ 0.7.0 (RDS supports 0.8.0 on PG 16.5+/15.9+).
  `178128` opens with `CREATE EXTENSION IF NOT EXISTS vector` — if the extension isn't
  available, the migration fails on its first statement. If unavailable, stop and do a minor
  RDS engine bump (AWS console; the RDS instance is outside this repo's Terraform) before
  anything else.
- Also confirm `migration:show` lists all four as `[ ]` pending (sanity check).
- *Blast radius:* read-only. *Rollback:* n/a.

**B1. Run all 4 migrations against RDS.** (you, quiet window)
- `DATABASE_URL="postgresql://…?sslmode=require" DATABASE_SSL=true npm run migration:run`
- Expected: `1781280000000` through `1781310000000` all execute.
- `178130` deletes duplicate open jobs — **no-op this time** (table is empty; worker has
  never run). Its irreversibility hazard (finding D7) does not bite on this push, but the
  quiet-window guidance still stands for any later re-run against a live system.
- *Blast radius:* schema change on shared QA RDS — 11 new tables + extensions + `corpus_order`
  + sparse tables. *Rollback:* `npm run migration:revert` (one per invocation; `178131` →
  `178130` → `178129` → `178128`). **On the big path, reverting `178128/178129` drops the
  new tables and, via CASCADE, the migrated chunks — use env-flag rollback (§6) instead, not
  schema revert, if the backend is bad.**

**B2. Full Phase 0 corpus cutover — migrate 169 docs / ~30k chunks into RDS.** (you)
- This is the expensive step. Follow [`phase0-cutover.md`](runbooks/phase0-cutover.md)
  Production cutover Steps 3–4:
  1. On a host with AWS access + the venv, stage S3 docs **and** cache to `/tmp`:
     `aws s3 sync "s3://${DOCUMENTS_S3_BUCKET}/${DOCUMENTS_S3_PREFIX:-}" /tmp/askWRI_docs`;
     `aws s3 sync "s3://${DOCUMENTS_S3_BUCKET}/${CACHE_S3_PREFIX:-}" /tmp/askWRI_cache`.
     **Warm cache matters** — cold = re-embed 30k chunks via OpenAI (~$1 + minutes); warm =
     zero OpenAI calls.
  2. `cd search-service && DATABASE_URL="postgresql://…?sslmode=require" \
     ./venv/bin/python -m scripts.migrate_csv_to_postgres` → `Done: 169 documents, <N> chunks.`
     The script reuses the search-service's `indexing.build_nodes` to write chunks
     **byte-identical** to legacy (the §14.5 parity gate's foundation). It exits non-zero on
     error and is idempotent if the tables are empty.
  3. Verification SQL (phase0-cutover.md Step 4): `docs=169, searchable=169, texts=169,
     missing_embeddings=0, in_collection=169`. Spot-check a chunk.
- ⚠️ **Do NOT use `--reset`** — it's a fresh DB so you don't need to, and on any live DB it
  `TRUNCATE CASCADE`s into `ingestion_jobs` (finding D6). Only `--reset` on a quiet DB you
  intend to wipe.
- *Blast radius:* writes the entire corpus into RDS (~30k chunk rows + HNSW index).
 *Rollback:* re-run with `--reset` on a **quiet** DB (destroys jobs — D6), or revert
  `178128/178129` (drops tables + corpus — prefer env-flag rollback instead).

**B3. Sparse keyword backfill against RDS.** (you; worker idle — trivially true on first push)
- `cd search-service && DATABASE_URL="postgresql://…?sslmode=require" \
  ./venv/bin/python -m scripts.build_sparse_keyword`
- Expected: `wrote ~30526 vectors …; vocab 184395; avgdl ~192` (~1–2 min). Idempotent, one
  atomic transaction. Needs only `DATABASE_URL` (no S3/OpenAI).
- Verify: `SELECT count(*) FROM document_chunks dc JOIN documents d ON d.id=dc.document_id
  WHERE d.status='searchable' AND dc.sparse IS NOT NULL;` → every searchable chunk.
- *Blast radius:* populates `document_chunks.sparse` only. *Rollback:* `UPDATE
  document_chunks SET sparse=NULL` (revert to needing `KEYWORD_BACKEND=memory`).

**B4. Parity + golden-set eval gate (strongly recommended before merge — big path only).**
(you)
- On a host with the migrated RDS reachable, start the search-service in postgres mode on
  port 8001 alongside the running legacy instance (8000):
  `cd search-service && RETRIEVAL_BACKEND=postgres DATABASE_URL="postgresql://…" \
  ./venv/bin/python -m uvicorn app.main:app --port 8001`
- `./venv/bin/python -m scripts.compare_query_parity --legacy http://127.0.0.1:8000 \
  --candidate http://127.0.0.1:8001` → gate: exit 0, mean top-20 overlap ≥ 0.95, no rank-1
  mismatches. (Note: the recorded Phase-0 result was overlap 0.940 / 2 rank-1 swaps — passed
  by judgment, not the numeric threshold; see findings doc R-context. Get explicit sign-off
  if the number is again under 0.95.)
- `npm run eval:cite` and `npm run eval:answer-retrieval` against the postgres backend →
  design §14.5 acceptance: cite precision/F1 within ±1 of legacy; answer chunk/doc P/R/F1
  within ±2.
- *Why this matters on the big path:* the corpus is being written for the first time. If you
  skip it, the first signal that the migration was wrong comes *after* the deploy, from
  users. *Blast radius:* read-only. *Rollback:* n/a — if it fails, do not merge (D3); fix the
  migration and re-run B2/B3/B4.

### Phase C — GitHub secrets (you; GitHub admin)

**C1. Create `INGESTION_WORKER_ENV` (NEW GitHub secret).**
- JSON: `{"DATABASE_URL":"postgresql://…?sslmode=require","OPENAI_API_KEY":"sk-…"}`. Read by
  both `deploy-qa.yml` and `deploy-production.yml`; lands as plain-text env in the worker
  task def (SSM deferred — finding I-6).
- *Blast radius:* if missing, the worker boots without DB/OpenAI → crash-loop. *Rollback:*
  remove the secret + redeploy (worker won't start — acceptable, the other two services run).

**C2. Add `SESSION_SECRET` (≥32 chars) to the existing `ASKWRI_APP_ENV` secret JSON.**
- `openssl rand -hex 32`. Without it, admin login fails closed (all `/admin` 401s — the
  app refuses sessions without a valid secret). Optionally add `ADMIN_API_TOKEN`.
- *Blast radius:* missing → admin UI unusable, but the public app + search still serve.
  *Rollback:* remove the key, redeploy.

**C3. Verify `SEARCH_SERVICE_ENV` has `DATABASE_URL` + `RETRIEVAL_BACKEND=postgres`.**
- If `KEYWORD_BACKEND` is unset, it defaults to `sparse` (requires B4 done). If B4 could not
  run before push, set `"KEYWORD_BACKEND":"memory"` here as the fallback (runbook Step 5),
  then flip to sparse after backfilling.
- *Blast radius:* wrong backend → boot guard 500s `/query` (sparse w/o backfill) or stale
  BM25 (memory). *Rollback:* change the secret + redeploy.

### Phase D — Push / PR / deploy (you; triggers the deploy)

**D1. Push `qa-wip-david` to `origin`.** (you)
- `git push origin qa-wip-david` (updates the remote personal branch; triggers nothing).
- *Blast radius:* none — branch update only. *Rollback:* `git push --force origin <old-sha>`.

**D2. Open PR `qa-wip-david → qa`.** (you)
- `gh pr create --base qa --head qa-wip-david`. Wait for `pr-check.yml` to go green:
  Jest `test:ci` + build, the 7 Python DB tests, docker build (both images), terraform
  fmt+validate. **Review the docker-build job output** — it's the only CI signal that the
  images build (B1's missing-worker would surface here only as a build artifact, not a
  failure, since it doesn't `import worker.main`).
- *Blast radius:* none (CI only). *Rollback:* close the PR.

**D3. Merge the PR (triggers `deploy-qa.yml`).** (you, at a chosen time)
- This pushes to `qa` → deploy runs: test → build+push 2 images (tagged `:sha` + `:latest`)
  → `terraform init/validate/plan/apply` (creates the new ingestion-worker service + task
  def + IAM + security groups) → `aws ecs update-service --force-new-deployment` ×3 →
  `aws ecs wait services-stable`.
- ⚠️ **Watch the terraform plan output in the Actions log while it applies** (no plan-only
  gate — the first real plan against state happens inside the apply job). Confirm the new
  `aws_ecs_task_definition.ingestion_worker` + `aws_ecs_service` + IAM are added, nothing
  unexpected destroyed.
- ⚠️ **Old-code-on-new-schema window:** between `terraform apply` and the new tasks
  stabilizing, the OLD app/search-service briefly runs against the NEW schema. Safe only if
  migrations are additive — `178130`/`178131` are (new tables + index/FK tightening on a
  table the old code doesn't use). If `178128`/`178129` also ran, the old code also ignores
  those new tables. Confirmed safe by the runbook, but verify the plan output.
- *Blast radius:* the deploy. If `services-stable` fails, the worker (B1) or search-service
  (sparse boot guard) is failing — see Phase E / rollback. *Rollback:* see §6.

### Phase E — Post-deploy verify (you; ECS exec)

**E1. Seed the admin user.** (you)
- `DATABASE_URL="postgresql://…?sslmode=require" DATABASE_SSL=true npm run seed:admin --
  <user> <password>` → `Created admin user '<user>'`. (Password lands in shell history —
  clear it or prefix with a space.)
- *Blast radius:* none. *Rollback:* `UPDATE users SET active=false WHERE username='<user>'`.

**E2. Verify from inside a task (ECS exec; search-service is service-discovery-only, not on ALB).**
- `/health` → `"status":"healthy"`, `"keyword_backend":"sparse"`, `"retrieval_backend":"postgres"`.
  (The two backend fields are new — their absence means an old image is still running.)
- `/query` smoke → 200 with non-empty results.
- Web UI: `https://qa.askwri-app.org` public search; `https://qa.askwri-app.org/admin`
  login → admin shell; `/admin/review`, `/admin/documents` render.
- Worker: `aws logs tail /ecs/askwri-app-qa-ingestion-worker --follow` → periodic poll/sweep,
  no crash-loop.
- Audit: make one admin mutation, then `SELECT actor_user_id, source, action, entity_type, at
  FROM audit_log ORDER BY at DESC LIMIT 5;` → a fresh `source='human'` row.
- *Blast radius:* read-only. *Rollback:* n/a.

## 6. Rollback (per layer)

| Layer broke | Rollback |
|---|---|
| Sparse keyword lane (bad rankings / boot 500) | Env flip: set `KEYWORD_BACKEND=memory` in `SEARCH_SERVICE_ENV`, redeploy. Legacy in-memory BM25 hydrates from Postgres chunks at boot (lifecycle then needs `/reindex`). |
| Schema (bad migration) | `npm run migration:revert` (one per invocation; `178131` first, then `178130`). `178130`'s `down` can't restore deleted dup jobs. Reverting `178128/178129` drops tables — only if willing to lose the migrated corpus. |
| Bad image / bad code | Re-point ECR `:latest` at the last good `:sha` and force-new-deployment (runbook §Step 8), or `git revert` + push (rebuilds/redeploys through the pipeline). |
| Whole deploy | `KEYWORD_BACKEND=memory` + `RETRIEVAL_BACKEND=legacy` in `SEARCH_SERVICE_ENV`, unset `CATALOG_SOURCE=postgres` in `ASKWRI_APP_ENV`, redeploy. Search-service reverts to CSV+S3 boot; `start.sh` re-enables the full sync. (Note: the R1 fix keeps the documents sync in both modes, so PDF serving stays up either way.) |

## 7. What I can do from here vs. what needs you / AWS

- **I can (no credentials):** Phase A (local integration + re-verify), write/commit the plan,
  author CI tweaks (e.g., add `REQUIRE_DOCKER_TESTS=1` + the B1 Docker test to `pr-check.yml`).
- **Needs you (AWS + GitHub + RDS):** Phase B (RDS cutover: B0 extension preflight → B1
  migrations → B2 corpus migration → B3 sparse backfill → B4 parity/eval gate), Phase C
  (GitHub secrets), Phase D (push + PR + merge), Phase E (ECS exec verify + seed admin).
- **I cannot push to `origin/qa`** (the deploy trigger) without your explicit go-ahead, and I
  would not — the ordering in Phase B/C must be complete first or the deploy bricks `/query`.

## 8. Decisions needed before executing

1. **Push strategy:** PR (Path A, recommended) vs. direct merge-to-qa (Path B). Confirms
   whether a PR is the team's review path.
2. ~~Has Phase 0 run against QA RDS?~~ — **RESOLVED 2026-07-01: no. Big path confirmed.**
   The scope question is answered; B0–B4 below are the cutover.
3. **Sparse-or-memory on first boot:** default `sparse` (needs B3 done before push) vs.
   `KEYWORD_BACKEND=memory` fallback (deploy first, flip to sparse after backfill). Recommend
   sparse if B3 runs cleanly; memory if RDS access is delayed.
4. **When to push:** the deploy has a brief ingestion pause (worker stop-then-start by design)
   and B1 is best run in a quiet window. Pick a low-traffic QA window — budget ~1 hour+
   end-to-end (B0–B4 + the deploy).
5. **Add the B1 Docker test to CI?** (Out of scope for this push, but `services-stable` is
   currently the only thing that catches a missing `worker/` COPY — the B1 fix is in, but
   regression-protecting it in CI is a follow-up.)

## 9. Doc-drift this push creates (fix after deploy, not blocking)

- `phase0-cutover.md` Step 6 says "start.sh skips the S3 sync when RETRIEVAL_BACKEND=postgres"
  — **no longer true after the R1 fix**: start.sh now syncs documents in postgres mode and
  skips only the cache. Update that line and the "Remove DOCUMENTS_S3_BUCKET" suggestion
  (keep it set so PDFs sync).
- The runbook's `seed-admin` "will not overwrite" note is wrong (finding D, §3 of the
  findings doc). Fix alongside.
- `phase0-cutover.md` §5 still describes `--reset` as safe for "re-running after a schema
  change" without mentioning the `ingestion_jobs` CASCADE (finding D6). Add the warning.

---

## Recommended execution order (the short version)

1. **B0 RDS preflight** — `SELECT version()` + `pg_available_extensions` for `vector`; if
   unavailable, engine bump first. This gates everything.
2. **Phase A** (local merge + verify — I can do this now) and **B1** (run all 4 migrations)
   can proceed in parallel once B0 passes; A is credential-free.
3. **B2 corpus cutover** (stage S3 warm cache + `migrate_csv_to_postgres` + verify SQL) — the
   expensive step; quiet window.
4. **B3 sparse backfill** (`build_sparse_keyword`) — must precede any sparse-mode boot.
5. **B4 parity + eval gate** (compare_query_parity + eval:cite + eval:answer-retrieval) —
   strongly recommended before merge on the big path.
6. **Phase C** (GitHub secrets: `INGESTION_WORKER_ENV` new, `SESSION_SECRET` added,
   `SEARCH_SERVICE_ENV` verified) — you.
7. **Phase D1–D2** (push branch + open PR) — you; I can prep the `gh` command.
8. Watch pr-check go green; **merge (D3) at a chosen time** → deploy runs.
9. **Phase E** (seed admin + verify) — you.

**The single most important safety rule:** do not merge the PR (D3) until B0–B4 and C are
complete. The deploy will otherwise boot a search-service that 500s every query (sparse
guard) and an ingestion-worker that crash-loops if B1 were unfixed (it's fixed, but the
point stands: the pre-deploy cutover ordering is the only gate).
