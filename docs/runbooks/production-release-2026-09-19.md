# Production release — qa → production, 2026-09-19 (rev 4)

> **Goal, in one sentence:** bring production's code and data up to qa's current state, without
> running a single ingest, classification, summarization, or embedding job.
>
> Rev 4 is a rewrite, not an edit. Two adversarial reviews falsified enough of rev 3 — including
> parts of its §1 "measured" section — that patching it would have preserved the errors. Every
> claim below was measured on 2026-09-19 against the live systems, or is marked UNVERIFIED.
>
> **Rev 3's §2 (the credential narrative) is deleted.** It was built on a misread AWS parameter.
> What actually remains true from it is recorded in §9.

---

## 0. What this release is

1. **A code release.** PR `qa` → `production`, merged as a **merge commit**, which fires
   `deploy-production.yml`: test → build 2 images → `terraform apply` → force-new-deploy of the
   app and search-service.
2. **A schema release.** 5 pending migrations applied by hand to the prod RDS. The workflow runs
   no migrations.
3. **A targeted data reconciliation**, qa → prod, for the ~3,400 rows that actually differ. No
   re-ingest, no re-OCR, no re-embedding.

**What it is not:**
- Not a corpus re-ingest. `document_texts` is checksum-identical between environments.
- Not `scripts/clone-corpus.sh`. See **H1**.
- Not a `main` push. `main` is stale and would *downgrade* prod.
- Not a pipeline run. The ingestion worker is off for the entire write window (§4 Phase 0) and is
  restored only after every gate has passed (§4 Phase 7).

---

## 1. Verified current state — measured 2026-09-19

Everything in this section was measured today. Where rev 3 asserted something different, the
correction is marked **[rev 3 was wrong]**.

### 1.1 Serving — what production is actually running

| service | task definition | image | desired/running |
|---|---|---|---|
| `askwri-app-production-service` | `:16` | `7c91ffe…` | 1 / 1 |
| `askwri-app-production-search-service` | `:16` | `7c91ffe…` | 1 / 1 |
| `askwri-app-production-ingestion-worker` | **`:1`** | **`c1af292…`** | 1 / 1 |

**[rev 3 was wrong]** Rev 3's serving table said all three run `7c91ffe`. The worker runs
`c1af292` — the 2026-08-07 `production` tip — on **task definition revision 1**. It has never
moved. Terraform registered worker revision `:3` (image `7c91ffe`) during the 2026-09-02 deploy
and the service was never repointed to it, even though that workflow run concluded `success` and
included an explicit `--force-new-deployment`.

This matters because `--force-new-deployment` relaunches the task definition a service is
*already pointed at*. It cannot change an image. Only Terraform writing
`aws_ecs_service.ingestion_worker.task_definition` (`terraform/infrastructure/ecs.tf:1060`) moves
it, and that has demonstrably not happened across two deploys. **Root cause is unknown — see
§8.1.** Consequence for this release: nothing may assume the worker will pick up new code on its
own.

qa's image is `c035a62` (#425); qa branch HEAD is `51cf9f9` (last two commits docs-only, which is
why the image trails the branch).

### 1.2 Production has never ingested a document

```
production=> select status, count(*), min(created_at)::date, max(created_at)::date
            from ingestion_jobs group by status;
 done | 1 | 2026-08-07 | 2026-08-07
```
One row, from cutover day. The worker's newest CloudWatch stream contains exactly two lines,
both from startup on 2026-09-11 (`Ingestion worker started`, `Postgres connection pool opened`)
and nothing since. `s3://askwri-data/intake/` is **empty** (0 objects).

The prod ingestion lane has never been used. Turning the worker off for this release removes no
in-flight work and interrupts nothing.

### 1.3 Branch reconciliation

- `git log origin/qa..origin/main` → empty.
- `git log --no-merges origin/qa..origin/production` → empty. (The plain `origin/qa..origin/production`
  log is *not* empty and never will be: a `qa`→`production` merge commit is by construction not an
  ancestor of `qa`. `production-release.md` §1 states the wrong check; fixing it is part of this PR.)
- **Merge safety proven:** `git merge-tree --write-tree origin/production origin/qa` → `ab57052e…`,
  and `git diff <that tree> origin/qa` is empty. The merge tree **equals qa's tree exactly**, so CI
  on the merge commit is the same CI that already passed at `c035a62`.
- Content delta qa vs production: 401 files, +97,636 / −32,963.

### 1.4 Routes removed by the merge

**[rev 3 was wrong]** Rev 3 warned that "external callers of `/api/relates` and `/api/why` will
404." Both are **already absent** from `origin/main`, which is what production runs — they 404
today. Rev 3 compared against the `production` *branch* rather than the deployed image.

Diffed correctly (`git diff --diff-filter=D --name-only origin/main origin/qa -- src/`), the merge
removes **seven** `/api/eval/**` routes:
`eval/labels`, `eval/labels/override`, `eval/review-labels`, `eval/review-synthesis`,
`eval/synthesis-eval`, `eval/synthesis-eval/review`, `eval/synthesis-raw`.

These were deleted on qa **deliberately** by commit `243f0b2` — *"chore(eval): delete gen-1 answer
eval scripts, data, routes, and npm scripts (spec §3)"*. The gen-2 routes `eval/review-cite` and
`eval/cite-report` survive on qa. This is a cleanup already approved weeks ago, completing itself
on prod. **Action: one confirmation with the eval-review owner** that nobody bookmarked the
production URLs for the gen-1 pages. Not a blocker.

### 1.5 Pending migrations on the prod RDS (5)

```
[ ] 1786579200000  document_relations
[ ] 1787160000000  TopicTaxonomy   (tags.parent_tag_id/description/needs_reembed,
                                    tag_aliases, tag_embeddings, reclassify_jobs)
[ ] 1787251200000  GeographyFacet  (7 continents + 194 countries = 201 tags)
[ ] 1787480000000  SearchVocab     (CREATE EXTENSION pg_trgm + search_vocab)
[ ] 1788000000000  ExpertsQueryLogs
```
All read: none contains `DROP` or `TRUNCATE`; all are `ADD COLUMN` (nullable or defaulted) or
`CREATE TABLE`/`CREATE INDEX`. `1788000000000` is also pending on qa — harmless, nothing writes
`experts_mode_query_logs` outside a test.

**`pg_trgm` is already installed on production.** Prod extensions: `pg_trgm, plpgsql, uuid-ossp,
vector` — matching qa. The SearchVocab migration will pass.

**[rev 3 was wrong]** Rev 3 said "each migration is individually transactional, so a failure leaves
no partial migration — read which one failed." `src/db/migration-data-source.ts` sets no
`migrationsTransactionMode`, so TypeORM's default `"all"` applies and `package.json:21` passes no
`-t`. **All five run inside ONE transaction.** The outcome is *safer* than rev 3 described
(all-or-nothing), but the recovery advice was wrong: a failure rolls back all five, and
`migration:show` will still list all five as pending. There is no "which one failed" state.

**[rev 3 was wrong]** The GeographyFacet migration's own docblock says "7 continents + 195
countries"; the actual `VALUES` list holds **194** countries + 7 continents = **201**, which
matches qa's measured 201 geography tags exactly. Rev 3's step 29 said 202. Both were off by one.
The identity-tuple sets reconcile perfectly, which is what makes the taxonomy copy clean.

### 1.6 Missing objects on prod

`search_vocab`, `document_relations`, `tag_aliases`, `tag_embeddings`, `reclassify_jobs`,
`experts_mode_query_logs` — all absent, all created by the migrations.
`keyword_corpus_stats` present and correct.

### 1.7 Corpus parity — measured per object

| object | prod | qa | verdict |
|---|---|---|---|
| `documents` | 206 | 206 | same 206 `external_id`s, **same UUIDs**; 70 rows differ across 12 columns |
| `document_texts` | 206 | 206 | **checksum identical** |
| `document_chunks` | 35,449 | 35,449 | **2 docs differ, 94 rows** — see 1.8 |
| `document_summaries` | 518 | 518 | **30 rows differ across 12 docs**; PK is `(document_id, language, kind)` |
| `document_relations` | absent | 18 | 11 confirmed + 7 rejected |
| `tags` | 18 | 976 | 757 topic, 201 geography, 8 doc_type, 9 office, 1 program |
| `tag_embeddings` | 0 | 958 | all `cohere-embed-v4` |
| `document_tags` | 1,013 | 2,149 | see 1.9 |
| `collections` / `document_collections` | 1 / 167 | 1 / 167 | identical |

**Sparse lane — fully consistent, measured (this falsifies a review finding):**
- `keyword_corpus_stats` is **byte-identical** on both sides: `n_chunks=35449`, `avgdl=190.1119`,
  `k1=1.5`, `b=0.75`, `sparse_dim=1000000`.
- `keyword_vocab`: 298,231 prod / 298,206 qa. **25 prod-only tokens, 0 qa-only**, and **all 298,206
  shared tokens have identical `df` and `idf`.**
- `null_sparse` = 0 on both. `embedding_model` is uniformly `cohere-embed-v4` on all 35,449 chunks,
  both sides.

There is therefore **no BM25 scoring skew** and no `avgdl` divergence. The 94 copied sparse vectors
score on exactly the same scale as the rest of the corpus. `build_sparse_keyword.py` must **not**
be run.

**`(document_id, chunk_index)` is unique on both sides** (0 duplicate keys measured), so it is a
safe match key for `UPDATE … FROM` even though no constraint enforces it.

**qa has 0 tags with `needs_reembed = true`** (of 976). Copying qa's `tags` verbatim therefore
satisfies both the checksum gate *and* the no-Bedrock-wave goal with the same write — there is no
tension between them, and no separate "clear the flag" step is needed.

### 1.8 The two divergent documents — measured per column

**[rev 3 was wrong]** Rev 3 listed 6 columns for chengdu (`text`, `embedding`, `embedding_model`,
`dimension`, `sparse`, `node_metadata`) and "sparse at minimum" for medindo. Measured across all
17 columns:

| document | chunks | columns that differ |
|---|---|---|
| `2017_chengdu-low-carbon-blueprint_00027` | 39 | `text` (1/39), `embedding` (26/39), `sparse` (39/39), `corpus_order` (39/39) |
| `2021_medindo-mp25-com-sensores-de-baixo-custo_6821` | 55 | `embedding` (11/55), `sparse` (55/55), `corpus_order` (55/55) |

- **`corpus_order` was missing from rev 3's copy list entirely** and differs on all 94 rows. It is
  indexed (`1781290000000-Migration.ts:13`).
- `embedding_model`, `dimension` and `node_metadata` do **not** differ — rev 3 would have copied
  three columns needlessly.
- No structural column differs: `unit_type`, `unit_number`, `section_path`, `page`, `caption`,
  `structured`, `language`, `legacy_chunk_id` all match. Chengdu was **not** re-chunked; one
  chunk's text was corrected.
- Corpus-wide check: `corpus_order` is identical on 35,355 of 35,449 rows, so the drift is confined
  to exactly these 94 rows. The "two divergent documents" framing holds.

**Copy these four columns only: `text`, `embedding`, `sparse`, `corpus_order`.**

### 1.9 `document_tags` — measured, and one finding rev 3 missed entirely

| source / status | prod | qa |
|---|---|---|
| `external` / accepted | **647** | 646 |
| `human` / accepted | 6 | **15** |
| `llm` / accepted | 317 | 1,455 |
| `llm` / suggested | 43 | 33 |
| **total** | **1,013** | **2,149** |

- **prod's 6 human rows are a strict subset of qa's 15.** qa holds 9 human curation decisions prod
  has never seen. All 9 reference `office`/`doc_type`/`program` tags — which are exactly the 18
  tags that **already share UUIDs across both environments**, so they insert with no ID remapping.
- **The 647-vs-646 external gap and one of the 9 missing human rows are the same edit.** On
  document `2020_design-manual-on-safe-access-to-public_5869`:

  | | production | qa |
  |---|---|---|
  | `doc_type` | **Guidebook** (`source='external'`) | **Report** (`source='human'`) |

  A human on qa decided that document is a Report, removed the external `Guidebook` row, and added
  a human `Report` row. Copying only the human row would leave production asserting the document is
  **both** a Guidebook and a Report — worse than either environment is today. See **D4**.

### 1.10 Tag identities are NOT stable across environments

`tags` has `UNIQUE (facet, value_id, taxonomy_version)`, but UUIDs are generated independently per
database (`uuid_generate_v4()`). Measured: 18 shared ids, **958 qa-only, 0 prod-only**. The 18
shared ones came across in the 2026-08-07 clone.

This is the whole reason the taxonomy copy mechanism needed deciding. See **D2**.

### 1.11 Config deltas

**[rev 3 was wrong]** Rev 3 said "`production.tfvars` unchanged — nothing to sync," having diffed
only `.tfvars` against `main`. The correct diff is `git diff origin/production origin/qa --
terraform/`:

- **`variables.tf`: `worker_llm_model` default `"gpt-5-mini"` → `"gpt-5.6-luna"`.**
  `production.tfvars` never sets this, so prod inherits the default. Live proof: worker TD `:1`
  carries `WORKER_LLM_MODEL = gpt-5-mini`; TD `:3` carries `gpt-5.6-luna`. See **D5**.
- `ecs.tf`: `PYTHONUNBUFFERED` added to search_service and ingestion_worker. Prod TD `:16` already
  carries it once (sourced from `main`); no duplicate.
- qa-only flags are **six**, not the two rev 3 listed: `QUERY_UNDERSTANDING_ENABLED`,
  `QUERY_EXPANSION_LANES_ENABLED`, `QUERY_UNDERSTANDING_LLM_ENABLED`, `DEEP_RESCUE_MAX`,
  `EXPANSION_FACETS`, `worker_llm_model`. **Do not sync any of them** (except `worker_llm_model`
  per D5). Prod runs code defaults, which are off.

**No new runtime env var is required by this release.** Every new search-service setting has a
default and is flag-dark. `embedding_model` defaults to `cohere-embed-v4`, `keyword_backend` to
`sparse`, so prod's missing `EMBEDDING_MODEL`/`KEYWORD_BACKEND` are correct, not gaps.
No new GitHub Environment secrets.

### 1.12 Shared infrastructure — two facts that change the risk profile

- **One RDS instance hosts both databases.** `askwri-db1`, `db.t4g.small` (2 vCPU burstable,
  ~2 GB RAM), 20 GB, single-AZ, `BackupRetentionPeriod = 7`. `production.tfvars` and `qa.tfvars`
  differ only in `DB_NAME`. Anything heavy run against prod's DB also degrades qa, and vice versa.
- **One S3 bucket, identical prefixes.** Both environments use `askwri-data` with `documents/`,
  `cache/`, and (by unset default) `intake/`. **Nothing in S3 needs copying** — that is why
  `document_texts` is already identical. But it also means qa's worker can consume anything dropped
  in `intake/`. See **H4**.

### 1.13 What the deploy workflow actually does

On push to `production` (path-ignoring `docs/**`, `*.md`): `npm ci` → `npm run test:ci` →
`npm run build` → build+push both images → `terraform apply` (secrets from the `production` GitHub
Environment) → `--force-new-deployment` on all three services → `aws ecs wait services-stable`.
No migrations, no backfills.

Two properties that matter:
- **`terraform apply` starts a rollout, then the deploy job starts a second one** on top of it.
- **There are no protection rules.** `gh api repos/wri/askwri/environments` → `protection_rules: []`;
  `branches/production/protection` → 404. The merge *is* the deploy, with nothing in between.

---

## 2. Decisions

| # | Decision | Answer |
|---|---|---|
| D1 | Mirror depth | **Everything.** qa data is canonical. Code + schema + all differing data. |
| D2 | Taxonomy copy mechanism | **Preserve qa's UUIDs** (delete migration-seeded geography tags, insert qa's `tags` rows verbatim). The admin import/export path is unusable — see H2. |
| D3 | The two divergent documents | **Copy both**, four columns each (§1.8). |
| D4 | Human + external tag rows | **Mirror fully, including the deletion.** Insert qa's 9 human rows; delete prod's orphaned external `Guidebook` row. A deliberate, recorded, one-row exception to the CLAUDE.md write-ownership rule, justified because a human on qa superseded that row. |
| D5 | Worker LLM model | **Take `gpt-5.6-luna`** (parity with qa). Recorded as an unevaluated cost/output change — qa runs it, production never has. |
| D6 | Withdrawal of `2022_toward-credible-transport-carbon-dioxide_5852` | **Approved.** It is withdrawn on qa; copying `status` removes it from production retrieval. |
| D7 | Experts mode | **Ships live.** `/experts` has no flag and becomes publicly reachable at merge. This makes the taxonomy copy a hard dependency, not an admin nicety — gated in Phase 6. |
| D8 | Ingestion worker | **Off for the entire write window; restored in Phase 7 on the release image**, only after the embedding-completeness gate passes. |
| D9 | Backup mechanism | **RDS snapshot**, not a full `pg_dump`. See H6. |
| D10 | Merge method | **Merge commit.** Not squash, not rebase. |

---

## 3. Hazards

**H1 — `scripts/clone-corpus.sh qa production` is unsafe. Do not run it.**
It runs `TRUNCATE <11 tables> CASCADE`. `ingestion_jobs.document_id` is `ON DELETE CASCADE` onto
`documents` (changed from `SET NULL` by `1781300000000-Migration.ts:33-36`), so truncating
`documents` truncates `ingestion_jobs` — contradicting the script's own docblock. After the
migrations, `reclassify_jobs` carries the same FK. The script also misses `tag_aliases`,
`tag_embeddings`, `search_vocab`, `reclassify_jobs`, `experts_mode_query_logs`, and rebuilds the
HNSW index, taking retrieval offline for minutes. The measured delta is ~3,400 rows.

**H2 — the admin topics import/export cannot do the taxonomy copy.** Rev 3's step 16 was built on
it. Three independent defects:
1. `exportTopicsCsv` emits qa's `id` as the last CSV column (`topicsAdmin.ts:1304`), and
   `buildTopicsImportDiff` hard-fails any row whose id is absent from the target
   (`topicsAdmin.ts:1032-1036`). Prod has **0** of qa's 757 topic UUIDs, so all 757 land in
   `conflicts` and `applyTopicsImport` throws before writing anything → **HTTP 409, zero rows**.
2. It is hard-scoped to `facet='topic'` (`topicsAdmin.ts:999`, `:1014`, `:1125`, `:1282`). It
   cannot carry geography, `tag_embeddings`, `document_tags`, or `document_relations` — ~2,650 of
   the ~3,400 rows.
3. Every row it creates or updates gets `needs_reembed = true` (`topicsAdmin.ts:1126`, `:1143`) —
   it would *manufacture* the Bedrock wave this release exists to avoid.

Even stripping the `id` column only fixes (1). It would still mint fresh prod-local UUIDs, making
the Phase 6 checksum gate permanently unpassable. **Mechanism D2 is the only one that can pass the
gate.**

**H3 — `verify-corpus-parity.sh` is scalar-only and cannot see content divergence.**
Its probes are counts (`chunks`, `null_sparse`, `vocab_terms`). It could not see either divergent
document. It will report **`vocab_terms` MISMATCH** on the happy path (298,231 vs 298,206) — the
script's own comment says that one is expected. Treating "all probes matched" as the gate would be
a green light over a real divergence. The real gate is the per-object checksum block in §7.

**H4 — the source of truth is not frozen.** Rev 3 scaled prod's worker to 0 and called the
two-writer hazard solved. But **qa's worker is live** (`askwri-app-qa-ingestion-worker`, desired 1,
running 1, TD `:88`) and both environments share `s3://askwri-data/intake/`. Anything dropped
there during the window is consumed by qa's worker and mutates the copy source mid-flight. Both
workers must be off.

**H5 — ECS "stable" and `/api/health` prove nothing on this release.**
- The search-service has **no container health check** (`ecs.tf:742-750`, commented out
  deliberately) and is not behind the ALB — it is reached via Cloud Map. Indexing is a background
  task (`main.py:842`), and `/health` returns **HTTP 200 unconditionally**, including for
  `"initializing"` and `"degraded - indexing error"` (`main.py:901-948`). The
  `deployment_circuit_breaker` has no health signal for this service and cannot detect a broken boot.
- On the app tier, the circuit breaker *does* roll back — and `aws ecs wait services-stable` then
  **succeeds**, because a completed rollback is a steady state. `/api/health` carries no build
  identity (`src/app/api/health/route.ts:20-26` returns `npm_package_version`, not a SHA).
- **A rolled-back deploy is indistinguishable from a successful one** unless you assert the live
  image. Phase 6 step 1 does exactly that.

**H6 — the Phase-1 backup is itself a production load event.** A full `pg_dump` streams 35,449
chunks × (1536-d dense + sparse) plus 206 full texts over the wire — order 1-2 GB — off the
`db.t4g.small` that also serves **live production queries and all of qa**. It evicts the buffer
cache prod's HNSW scans depend on and burns shared CPU credits, in a phase rev 3 called invisible.
`create-db-snapshot` is one server-side call, no egress, no cache pressure, and covers both
databases. See D9.

**H7 — Phase 4 is user-visible, and rev 3 said it wasn't.**
`status = 'searchable'` is **filtered live on every query**, not cached at boot —
`search-service/app/pg_store.py:41` (dense), `:203` (sparse), and the comment at `:219-221` says so
explicitly. Metadata and full texts *are* boot-cached (`main.py:775-776`). So the instant the
`documents` copy lands, the still-running old task:
- stops returning the withdrawn document (intended, just earlier than planned), and
- **starts returning chunks from the 23 newly-promoted documents whose text is not in its boot
  cache**, so `main.py:1902` yields empty passage context → degraded answers.

Rev 3 said "neither service reloads corpus state on its own." **False:** `POST /reindex`
(`main.py:2207`) re-runs `load_from_postgres()` behind a single-flight lock, with no task
replacement. Calling it closes the window in seconds. Phase 4 does.

**H8 — rev 3's rollback section did not work, in either half.**
- *Code:* "re-point the ECR `:latest` tag" is a no-op. All six container definitions use
  `:${var.image_tag}` (`ecs.tf:294, 323, 617, 641, 935, 959`), and `variables.tf:217-226` says so
  in as many words. Reverting the merge lands on `c1af292`, which is **older** than what prod runs
  and has no `src/app/api/admin/topics/**` at all — a bigger regression than the thing being
  rolled back.
- *Data:* "truncate-then-restore, per table" **fails outright** — `TRUNCATE` on an FK-referenced
  table errors regardless of whether referencing tables are empty, and `documents` is referenced by
  eight FKs. The operator's instinct under pressure is `CASCADE`, which wipes **`document_texts`
  (the 206-row OCR cache this release's whole "zero OCR cost" premise rests on),
  `document_collections`, `ingestion_jobs`, and `reclassify_jobs`** — none of which rev 3 backed up.
- *And it was unnecessary:* the mirror is **UPDATE-only** for `documents`, `document_chunks` and
  `document_summaries`. Nothing is inserted or deleted there. §5 is rewritten accordingly.

**H9 — `main` remains a live downgrade trigger.** `deploy-production.yml` fires on pushes to `main`
as well as `production`, and `main` is `7c91ffe`. Any future push to `main` deploys older code over
the new schema. Out of scope for execution; see §8.3.

**H10 — plaintext secrets in task definitions.** Prod's task defs carry `OPENAI_API_KEY`,
`MISTRAL_API_KEY`, `DB_PASSWORD` and `SESSION_SECRET` as plaintext `environment` entries rather
than a `secrets` block. This release must not change or print them. See §9.

---

## 4. Execution sequence

### Phase 0 — freeze both environments

1. **Stop BOTH ingestion workers** (H4). Prod first:
   ```bash
   aws ecs update-service --cluster askwri-app-production-cluster \
     --service askwri-app-production-ingestion-worker --desired-count 0 --region us-east-2
   aws ecs update-service --cluster askwri-app-qa-cluster \
     --service askwri-app-qa-ingestion-worker --desired-count 0 --region us-east-2
   aws ecs wait services-stable --cluster askwri-app-production-cluster \
     --services askwri-app-production-ingestion-worker --region us-east-2
   aws ecs wait services-stable --cluster askwri-app-qa-cluster \
     --services askwri-app-qa-ingestion-worker --region us-east-2
   ```
   Because Terraform has `ignore_changes = [desired_count]` on all three services
   (`ecs.tf:509`, `:795`, `:1084`), these stick. Nothing in the deploy will silently undo them.

2. **Assert the freeze took.** Both services `runningCount: 0`; `s3://askwri-data/intake/` empty;
   neither database has a `queued` or `running` row in `ingestion_jobs`.

3. Confirm `aws sts get-caller-identity` and RDS reachability for both environments.

### Phase 1 — backup and fingerprint, before any write

4. **Take an RDS snapshot** (D9, H6). One command, covers both databases, no load on the instance:
   ```bash
   aws rds create-db-snapshot --db-instance-identifier askwri-db1 \
     --db-snapshot-identifier pre-release-2026-09-19 --region us-east-2
   aws rds wait db-snapshot-available --db-snapshot-identifier pre-release-2026-09-19 --region us-east-2
   ```
   Record `LatestRestorableTime` as well — PITR is available with 7-day retention, so the true
   rollback floor is "any moment before Phase 3."

5. **Small per-table convenience dumps** (cheap, and useful for the surgical restores in §5):
   ```bash
   mkdir -p /tmp/prod-backup-2026-09-19
   for t in documents document_chunks document_summaries document_tags tags \
            document_texts document_collections ingestion_jobs; do
     if [ -n "$(./scripts/with-remote-env.sh production psql -X -t -A \
                 -c "select to_regclass('public.$t')")" ]; then
       ./scripts/with-remote-env.sh production pg_dump --no-owner --no-acl --data-only \
         --table=public.$t > /tmp/prod-backup-2026-09-19/$t.sql
     fi
   done
   ```
   The `to_regclass` guard matters: `pg_dump --table=` on a nonexistent table **exits 1** and leaves
   a 0-byte file — rev 3 said it "will dump empty," training the operator to read a failure as
   success. `document_texts`, `document_collections` and `ingestion_jobs` are in this list purely as
   insurance; nothing in this release writes them.
   **No `FULL-prod.sql`.** The snapshot supersedes it (H6).

6. **Capture the before-fingerprint** — run the §7 block against both environments and save it.
   It must reproduce §1.7 exactly. If the delta has grown, stop and re-measure.

### Phase 2 — branch prep (no deploy)

7. Update `production-release.md`: fix the §1 superset check (§1.3), replace its §6 snapshot with
   this release's items, and record that `pg_trgm` is now installed.
8. Open the release PR, **do not merge**:
   ```bash
   gh pr create --base production --head qa \
     --title "Release 2026-09-19: taxonomy, query understanding, experts mode"
   ```
   First line of the body must be `Refs #<N>` or `No issue — <reason>`. Confirm CI green
   (`pr-check.yml` runs on PRs targeting `production`).

### Phase 3 — schema

9. ```bash
   ./scripts/with-remote-env.sh production npm run typeorm -- migration:show -d src/db/migration-data-source.ts
   ./scripts/with-remote-env.sh production npm run migration:run
   ./scripts/with-remote-env.sh production npm run typeorm -- migration:show -d src/db/migration-data-source.ts
   ```
   Expect 5 applied, then all `[X]`. **All five run in one transaction** (§1.5): a failure rolls
   back all five and leaves all five pending. There is no partial state to diagnose — read the
   error, fix, re-run.

10. Post-check: `to_regclass` non-null for all six new tables; `pg_trgm` in `pg_extension`.

### Phase 4 — the data mirror

Order is load-bearing: `documents` first (so `/reindex` has something to reload), taxonomy before
`document_tags` (FK), everything before `build_search_vocab`.

11. **`documents`** — 70 rows, 12 columns, matched on `id` (UUIDs identical for all 206). Includes
    the 23 promotions and the 1 withdrawal (D6).

12. **Immediately call `/reindex`** to close the stale-cache window (H7) rather than leaving it
    open across the rest of Phase 4:
    ```bash
    TASK=$(aws ecs list-tasks --cluster askwri-app-production-cluster \
      --service-name askwri-app-production-search-service \
      --query 'taskArns[0]' --output text --region us-east-2)
    aws ecs execute-command --cluster askwri-app-production-cluster --task "$TASK" \
      --container askwri-app-production-search-service --interactive \
      --command "curl -s -X POST http://localhost:8000/reindex" --region us-east-2
    ```

13. **`document_summaries`** — 30 rows, matched on the **full PK `(document_id, language, kind)`**.
    Not `(document_id, kind)`: 412 distinct pairs cover 518 rows, so that key is ambiguous and
    writes the wrong language's text.

14. **`document_chunks`** — 94 rows across the two documents (§1.8), matched on
    `(document_id, chunk_index)` (verified unique on both sides, §1.7).
    **Copy exactly four columns: `text`, `embedding`, `sparse`, `corpus_order`.**
    Do not copy `embedding_model`, `dimension` or `node_metadata` — measured identical.
    **Do not truncate the table. Do not drop the HNSW index.**

15. **`document_relations`** — 18 rows, table is empty, plain insert. The `CHECK
    (document_id <> related_document_id)` and the two unique constraints will reject a malformed
    copy loudly rather than silently.

16. **Taxonomy (D2) — preserve qa's UUIDs.**

    a. **Pre-flight, not assumed.** The geography tags were created seconds ago by the migration and
       both workers are off, so this should be 0 — but check, because if it is not, the DELETE in
       (b) silently cascades away real `document_tags` rows including protected `external`/`human`
       ones:
       ```sql
       select count(*) from document_tags dt join tags t on t.id = dt.tag_id
        where t.facet = 'geography';   -- MUST be 0
       ```
    b. `DELETE FROM tags WHERE facet='geography' AND taxonomy_version='v1';`
       This is the exact statement the migration's own `down()` uses
       (`1787251200000-GeographyFacet.ts:127-128`), so it is a proven-safe form. The migration is
       recorded in `migrations` and will not re-run, so the seed rows will not reappear.
    c. Insert qa's 958 tag rows **in a single `INSERT … SELECT`**. `tags.parent_tag_id` is a
       non-deferrable self-FK whose check fires as an AFTER-ROW trigger at end-of-statement, so one
       statement is order-independent; multiple statements would require parents-first ordering.
       Copy `needs_reembed` verbatim — qa's value is `false` on all 976 (§1.7).
    d. `tag_aliases`, `tag_embeddings` — copy **verbatim, no remap**. The UUIDs now match.
    e. **Do not clear `needs_reembed` as a separate step.** It is already `false` everywhere, and
       the flag was never the right lever anyway: the worker's `build_all_embeddings`
       (`worker/stages/embed_tags.py:101-123`) fires on `NOT EXISTS (tag_embeddings row)` with **no
       flag filter**. Completeness of the embedding copy is what prevents a wave — gated in Phase 6.

17. **`document_tags`** (D4) — three writes, in this order:
    a. Delete the superseded external row:
       ```sql
       delete from document_tags dt using documents d, tags t
        where dt.document_id = d.id and dt.tag_id = t.id
          and d.external_id = '2020_design-manual-on-safe-access-to-public_5869'
          and t.facet = 'doc_type' and t.value_id = 'Guidebook'
          and dt.source = 'external';   -- exactly 1 row
       ```
       **This is the recorded CLAUDE.md write-ownership exception** (D4). Nothing else touches an
       `external` row.
    b. Insert qa's 9 missing `human` rows (all reference the 18 shared-UUID tags — no remap).
    c. Insert qa's `llm` rows using the app's own precedence-correct idiom
       (`search-service/worker/stages/classify.py:248-255`):
       ```sql
       insert into document_tags (document_id, tag_id, source, confidence, model_version, status)
       select … from qa_rows
       on conflict (document_id, tag_id) do update
          set confidence = excluded.confidence,
              model_version = excluded.model_version,
              status = excluded.status
        where document_tags.source = 'llm';
       ```
       A collision with an `external` or `human` row is a no-op — H5's precedence rule enforces
       itself rather than relying on operator care.

    Expected final count: **2,149**, identical to qa.

18. **Do NOT run `build_sparse_keyword.py`** (§1.7 — the sparse lane is measurably consistent;
    a rebuild without `SPARSE_EN_HANDLES=true` would silently strip non-English documents'
    English handles).

19. **`build_search_vocab`** — now, and only now. It reads `documents.title/title_en WHERE
    status='searchable'`, `tags WHERE facet='topic'`, and `tag_aliases`, so it must follow steps
    11 and 16:
    ```bash
    ./scripts/with-remote-env.sh production bash -c \
      'cd search-service && ./venv/bin/python -m scripts.build_search_vocab'
    ```
    Idempotent (delete-then-insert). Post-check `select count(*) from search_vocab > 0`.

    **Set expectations honestly:** `search_vocab` has exactly one consumer — `spell_suggest`, via
    `build_understanding`, which runs only when `query_understanding_enabled` is true
    (`understanding.py:54-60`). That defaults to `false` and prod's task definition carries no
    `QUERY_*` variable. **Nothing on production reads this table today.** Building it is correct
    preparation for enabling the flag later; it is *not* a release gate, and there is no
    did-you-mean behaviour to probe.

20. **Re-run the §7 fingerprint on both environments.** Every object must now be zero-difference
    except `keyword_vocab` (25 prod-only canary terms, benign and expected).

### Phase 5 — deploy

21. **Merge using "Create a merge commit"** — not squash, not rebase (D10). Either alternative
    creates a non-merge commit on `production` that is not an ancestor of `qa`, permanently
    breaking the `git log --no-merges origin/qa..origin/production` invariant §1.3 relies on, and
    invalidating the `merge-tree` proof. GitHub remembers the last method used per user, so check
    the dropdown.

22. Watch it: `gh run watch`. The workflow runs `terraform apply` (which starts one rollout) and
    then `--force-new-deployment` (which starts a second). Both are expected.

23. **The worker will NOT come back on its own** and **will not pick up the new image on its own**
    (§1.1, H5). Phase 7 handles both explicitly. Do not assume the deploy did it.

### Phase 6 — verification gates

**Run these in order. Gate 1 first — it is the only thing that distinguishes a successful deploy
from a silently rolled-back one (H5).**

24. **Gate 1 — assert the live image.**
    ```bash
    for s in service search-service; do
      TD=$(aws ecs describe-services --cluster askwri-app-production-cluster \
        --services askwri-app-production-$s --query 'services[0].taskDefinition' \
        --output text --region us-east-2)
      aws ecs describe-task-definition --task-definition "$TD" \
        --query 'taskDefinition.containerDefinitions[].image' --output text --region us-east-2
    done
    ```
    Both must equal the release merge SHA. If either shows the old SHA, the circuit breaker rolled
    it back — investigate before going further. (The worker is intentionally at 0 here.)

25. **Gate 2 — search-service actually booted.** ECS "healthy" proves nothing on this service
    (H5). Read the log:
    ```bash
    aws logs tail /ecs/askwri-app-production-search-service --since 15m --region us-east-2
    ```
    Must contain `✅ Postgres-backed retrieval ready (N documents)` and
    `📊 Keyword lane: Postgres sparse (N chunks)`. Then:
    ```bash
    aws ecs execute-command --cluster askwri-app-production-cluster --task "$TASK" \
      --container askwri-app-production-search-service --interactive \
      --command "curl -s http://localhost:8000/health" --region us-east-2
    ```
    Expect `keyword_backend: sparse`, `retrieval_backend: postgres`.

26. **Gate 3 — content checksums** (§7), both environments. All objects zero-difference except
    `keyword_vocab`. `verify-corpus-parity.sh qa production` may be run alongside, but read it as
    informational only (H3) — expect `vocab_terms` MISMATCH, benign.

27. **Gate 4 — embedding completeness. This is the gate that keeps the worker quiet (§4.16e).**
    ```sql
    select count(*) from tags t
     where t.facet in ('topic','geography') and t.taxonomy_version = 'v1'
       and not exists (select 1 from tag_embeddings te where te.tag_id = t.id);
    ```
    **MUST be 0.** If it is not, do not restore the worker — it will start a Bedrock wave on the
    next tick. Also assert `select count(*) from tag_embeddings` = **958**, all
    `embedding_model = 'cohere-embed-v4'`.

28. **Gate 5 — real queries, not health checks.**
    - `curl -s https://www.askwri-app.org/api/health` → `"status":"healthy"`.
    - `POST /api/llamaindex {"query":"What have we published on hydrogen?","mode":"cite"}` returns
      passages.
    - A newly-promoted document (e.g. `2014_qingdao-sustainable-transport_00033`) **is** returned
      by a cite query.
    - The withdrawn document `2022_toward-credible-transport-carbon-dioxide_5852` is **not**
      retrievable (D6).

29. **Gate 6 — Experts mode** (D7). This is the feature that goes live at merge, and it degrades
    *silently* if the taxonomy copy is incomplete — `/api/experts` falls through
    `isTopicDegraded` / `TOPIC_NO_MATCH` / the graph fallback and returns plausible-looking but
    topic-less results. So probe the substance, not the status code:
    `POST /api/experts` with a known topical query → assert **non-empty
    `understanding.matched_topics`** and **non-empty `people`**.

30. **Gate 7 — admin surface.** Admin tag management lists the copied taxonomy;
    `/api/admin/topics` round-trips.

### Phase 7 — restore the worker, deliberately

Only after Gate 4 passed.

31. **Repoint the worker to the release task definition.** The service is pinned to revision `:1`
    and will not move on its own (§1.1). Find the revision Terraform registered during Phase 5:
    ```bash
    aws ecs list-task-definitions --family-prefix askwri-app-production-ingestion-worker \
      --sort DESC --max-items 3 --region us-east-2
    aws ecs describe-task-definition --task-definition <newest> \
      --query 'taskDefinition.containerDefinitions[].image' --output text --region us-east-2
    ```
    Confirm the image equals the release SHA and `WORKER_LLM_MODEL = gpt-5.6-luna` (D5), then:
    ```bash
    aws ecs update-service --cluster askwri-app-production-cluster \
      --service askwri-app-production-ingestion-worker \
      --task-definition <newest> --desired-count 1 --region us-east-2
    aws ecs wait services-stable --cluster askwri-app-production-cluster \
      --services askwri-app-production-ingestion-worker --region us-east-2
    ```
    **`--force-new-deployment` will not do this.** It relaunches the currently-configured task
    definition; `--task-definition` is required.

32. **Assert it came up on the right thing:** `runningCount == 1`, live image == release SHA, and
    `aws logs tail /ecs/askwri-app-production-ingestion-worker` shows a poll line.
    **Watch for a Bedrock embedding wave for ten minutes.** If one starts, Gate 4 was wrong —
    scale back to 0 and re-check `tag_embeddings`.

33. **Restore qa's worker:**
    ```bash
    aws ecs update-service --cluster askwri-app-qa-cluster \
      --service askwri-app-qa-ingestion-worker --desired-count 1 --region us-east-2
    ```

34. **Prove the author repair is discharged** — and fix the probe while you are here.
    `production-release.md:196-199` defines "prod `audit_log` count for `author_format_repair` is 0"
    as the *done?* probe. A raw SQL copy of `documents.authors` writes no audit row, so that count
    stays 0 forever and the item regenerates at every future release. The script is idempotent by
    shape (`scripts/repair-author-formats.ts:15-17`), so run it **as a dry run** and require it to
    plan **0** changes:
    ```bash
    ./scripts/with-remote-env.sh production npm run repair:author-formats   # dry run, expect 0
    ```
    Then amend `production-release.md` §6 item 3 so the probe is the dry run, not the count.

35. **Write the provenance rows.** The mirror changed ~3,400 rows on production with no operator
    behind them. Insert one `audit_log` row per copied table
    (`source='release-2026-09-19'`, row counts) so prod's history explains itself.

36. Re-run `git log --no-merges origin/qa..origin/production` → must be empty (confirms D10 was
    honoured).

37. Record the decisions that are now owed follow-up: §8.

---

## 5. Rollback

Rewritten from scratch — rev 3's version did not work in either half (H8).

### Code

**The image is pinned by SHA, never `:latest`.** Re-tagging `:latest` does nothing.

- **Preferred:** re-run `deploy-production.yml` via `workflow_dispatch` from the previous
  production ref, so the GitHub Environment secrets are present.
- **Or:** `terraform apply -var="image_tag=7c91ffe…"` **from CI, never from a laptop.** A local
  apply lacks `TF_VAR_*_secret_env` and would register task definitions with **no credentials**
  (`ecs.tf:1028` renders `try(jsondecode(var.…), {})` with a `"{}"` default).
- **Rollback targets are not uniform:** `7c91ffe` for app + search-service, `c1af292` for the
  worker. Do **not** `git revert` the merge — that lands production on `c1af292`, which is older
  than what prod runs today and has no `src/app/api/admin/topics/**` at all.

### Schema

`npm run migration:revert` reverts one migration per invocation, newest first. Read each `down()`
first — reverting `1787160000000` **drops `tag_embeddings`, `tag_aliases` and the new `tags`
columns**, taking all copied taxonomy data with it.

### Data

**Never `TRUNCATE`.** It errors on FK-referenced tables, and the `CASCADE` an operator reaches for
under pressure destroys `document_texts` — the OCR cache this release's economics depend on.

The mirror is **UPDATE-only** for the three large tables and **INSERT-only** for the rest, so the
inverse is surgical:

| table | what the mirror did | rollback |
|---|---|---|
| `documents` | UPDATE 70 rows | restore the dump into a **staging schema**, then `UPDATE … FROM staging` on those 70 ids |
| `document_chunks` | UPDATE 94 rows, 4 columns | same, keyed on `(document_id, chunk_index)` |
| `document_summaries` | UPDATE 30 rows | same, keyed on `(document_id, language, kind)` |
| `document_relations` | INSERT 18 | `DELETE FROM document_relations` (was empty) |
| `tag_aliases`, `tag_embeddings` | INSERT | `DELETE` all (were empty) |
| `tags` | DELETE 201 geo + INSERT 958 | `DELETE FROM tags WHERE id NOT IN (<the 18>)`, then re-run migration `1787251200000`'s seed block |
| `document_tags` | +9 human, −1 external, upsert llm | restore from `/tmp/prod-backup-2026-09-19/document_tags.sql` into staging and reconcile |

**The real floor is the Phase 1 snapshot.** For anything worse than a single-table mistake:
`restore-db-instance-to-point-in-time` (or restore `pre-release-2026-09-19`) into a **scratch
instance**, then copy the affected tables back. Never restore over a live instance.

**RTO is unmeasured.** Time the Phase 1 dumps and write the number here — a surgical table restore
is minutes; a snapshot restore into a new instance is tens of minutes plus DNS/config work.

---

## 6. What is NOT verified

State these honestly rather than discovering them mid-window.

1. **Why `aws_ecs_service.ingestion_worker` is pinned to revision `:1`** despite two successful
   deploys. Settling it needs `terraform plan` / `terraform state show` against
   `production.backend.hcl`, which takes a state lock and needs the Environment secrets. **This is
   the highest-value ~15-minute probe left**, and Phase 7 step 31 works around it rather than
   fixing it. Root-cause it before the *next* release.
2. **Whether Phase 5's `terraform apply` finally moves the worker service.** Follows from (1).
   Phase 7 assumes it does not.
3. **Search-service index-load duration on production** — the length of the degraded-`/query`
   window inside the deploy (H5). qa's CloudWatch log has the two bracketing lines and would
   answer it in minutes. Measure it and record it here.
4. **Whether the seven deleted `/api/eval/**` routes have live external consumers** (§1.4).
   Needs ALB access logs or a word with the eval-review owner.
5. **Rollback RTO** (§5).
6. **`document_tags.status`/`confidence`/`model_version` for `(document_id, tag_id)` pairs present
   on both sides.** §1.9 compares source-bucket counts and the human/external sets by identity, but
   not per-row attribute values on the overlapping llm rows. The Phase 4.17c upsert overwrites them
   with qa's values by design; the §7 checksum will confirm the end state.

---

## 7. Reusable fingerprint block

Run in Phase 1 (before), Phase 4 step 20 (after the mirror), and Phase 6 Gate 3.

```bash
for e in production qa; do
  echo "=== $e ==="
  ./scripts/with-remote-env.sh $e psql -X -t -A -F'|' -c "
    select 'chunks', count(*),
           md5(string_agg(md5(coalesce(text,'')||coalesce(sparse::text,'')||
                              coalesce(embedding::text,'')||coalesce(corpus_order::text,'')),
                          '' order by document_id, chunk_index))
      from document_chunks
    union all select 'texts', count(*),
           md5(string_agg(md5(to_jsonb(t)::text), '' order by document_id)) from document_texts t
    union all select 'summaries', count(*),
           md5(string_agg(md5(to_jsonb(s)::text), '' order by document_id, language, kind))
      from document_summaries s
    union all select 'documents', count(*),
           md5(string_agg(md5(to_jsonb(d)::text), '' order by external_id)) from documents d
    union all select 'tags', count(*),
           md5(string_agg(md5(to_jsonb(t2)::text), '' order by facet, value_id, taxonomy_version))
      from tags t2
    union all select 'doc_tags', count(*),
           md5(string_agg(md5(dt.source||dt.status||coalesce(dt.confidence::text,'')), 
                          '' order by dt.document_id, dt.tag_id)) from document_tags dt
    union all select 'corpus_stats', count(*),
           md5(string_agg(n_chunks::text||avgdl::text||k1::text||b::text||sparse_dim::text,''))
      from keyword_corpus_stats"
done
```

**Calibration measured 2026-09-19 (before the mirror):** `texts` MATCH; `chunks`, `summaries`,
`documents`, `tags`, `doc_tags` all differ; `corpus_stats` MATCH. After Phase 4, **all seven must
match.**

Note the `chunks` digest now includes `embedding` and `corpus_order` — rev 3's covered only `text`
and `sparse`, which is why it could not see the `corpus_order` drift on all 94 rows (§1.8).

`tags` and `document_tags` are ordered by their **identity tuples**, not UUIDs, so the digest is
meaningful even if a future environment diverges on ids again.

---

## 8. Owed after this release

### 8.1 Root-cause the worker's stuck task definition
`aws_ecs_service.ingestion_worker` has ignored two Terraform-registered revisions. Phase 7 works
around it manually. Until this is understood, **no future release can assume the worker updates**,
and the same silent staleness will recur.

### 8.2 The worker LLM model change is unevaluated
D5 accepted `gpt-5-mini` → `gpt-5.6-luna` for parity with qa. qa runs it, but it has never run
against production's documents, and this release measures nothing about its cost or output quality.
Either pin `worker_llm_model` explicitly in `production.tfvars` (making it a recorded decision
rather than an inherited default), or run an eval before the first production ingest.

### 8.3 `main` is still a downgrade trigger (H9)
Either fast-forward `main` to the release commit (which itself fires a deploy — deliberately), or
add a required reviewer to the `production` GitHub Environment. The Environment currently has
`protection_rules: []` and the `production` branch has no protection at all, so the merge button is
the deploy button. **The durable fix is the Environment reviewer.**

### 8.4 The search-service cannot report its own health (H5)
`/health` returns 200 while initializing or degraded, and the container health check is disabled by
design. Until `/health` 503s on `indexing_in_progress` / `indexing_error`, ECS "stable" and the
deployment circuit breaker are both blind on the service that matters most for retrieval.

### 8.5 Secrets Manager migration (H10)
`OPENAI_API_KEY`, `MISTRAL_API_KEY`, `DB_PASSWORD`, `SESSION_SECRET` sit in task-definition
`environment` entries rather than a `secrets` block. Long-standing item; unchanged by this release.

### 8.6 Dead environment variables
No code reference after the merge: `HOTJAR_ID` and `LLAMA_CLOUD_API_KEY` on the search-service,
`LLAMA_CLOUD_API_KEY` and `NEXT_PUBLIC_HOTJAR_ID` on the app (`src/app/layout.tsx` hardcodes the
Hotjar snippet). Removing them means editing the GitHub Environment secrets and letting Terraform
re-render, which triggers a redeploy — so it is a separate, post-release change.

---

## 9. Deliberately out of scope

- Retrieval tuning, rerankers, thresholds, tiers, answer synthesis. The `/query` contract is
  untouched.
- The `production → qa` refresh direction.
- Merging or fast-forwarding `main` (§8.3).
- Production's `container_memory = 1024` vs qa's `512`. This release touches no
  `production.tfvars`, so the delta persists. (Prod has *more* memory than qa; the cutover
  runbook's "qa runs 2048" is stale and the "known-open 502 risk" rationale needs re-deriving
  before it is cited again.)
- **The RDS master credential.** Rev 3's §2 narrative is deleted as unreliable, but two facts from
  that episode survive and are owed to the instance owner: the `askwri-db1` master password was
  rotated on 2026-09-19 and the previous one is unrecoverable, and SSM parameter
  `askwri_db_user_admin` version 3 still contains the rotated value in AWS parameter history
  (version 4 restored the owner's original note byte-for-byte). **Recommendation: have the owner
  rotate the master password themselves**, which makes the history entry worthless and restores
  their access. The applications are unaffected — they connect as `askwri`, and the application
  `admin` password was never changed. No database role was created and no `CREATE` grant was given.

---

## 10. What changed from rev 3

| rev 3 claim | rev 4, measured |
|---|---|
| all three prod services run `7c91ffe` | worker runs **`c1af292` on task definition `:1`** and has never updated (§1.1) |
| the deploy force-new-deploys all 3 to the new image | it cannot move the worker's image at all; Phase 7 repoints it explicitly |
| Terraform re-asserts the worker's `desired_count = 1` | **false** — `ignore_changes = [desired_count]` on all three services |
| taxonomy copy via the admin import/export path | **unusable** — 409s on foreign ids, topic-only, re-mints UUIDs, sets `needs_reembed=true` (H2). Mechanism is now UUID-preserving copy |
| `document_tags`: copy `llm` rows only | **9 human rows and 1 superseded external row** were invisible to rev 3 (§1.9, D4) |
| chengdu differs in 6 columns; medindo "sparse at minimum" | **4 columns**, and `corpus_order` — omitted by rev 3 — differs on all 94 rows (§1.8) |
| each migration individually transactional | **one transaction for all five** (§1.5) |
| rollback: re-point ECR `:latest` | no-op; images are SHA-pinned (H8) |
| rollback: truncate-then-restore per table | errors on FK; `CASCADE` destroys `document_texts` (H8). Rewritten as staged UPDATE/DELETE + snapshot floor |
| Phase 1 backup is free | full `pg_dump` is a load event on the shared `db.t4g.small` (H6). Replaced by an RDS snapshot |
| "neither service reloads corpus state on its own" | **`POST /reindex` exists** and closes the stale-cache window in seconds (H7) |
| Phases 0-4 are user-invisible | **false** — `status` filters live per query, so the `documents` copy is immediately visible (H7) |
| worker pause solves the two-writer hazard | prod's worker was only half of it — **qa's worker is live on a shared intake prefix** (H4) |
| `production.tfvars` unchanged, nothing to sync | `variables.tf` flips `worker_llm_model` to `gpt-5.6-luna`; qa-only flags are **six**, not two (§1.11) |
| did-you-mean probe exercises `search_vocab` | **nothing on prod reads `search_vocab`** — the flag is off (§4.19) |
| the taxonomy is inert on prod for retrieval | **false** — Experts mode ships unflagged and depends on `tag_embeddings` (D7, Gate 6) |
| `/api/relates` and `/api/why` will 404 after this release | **already 404 today**; the merge removes seven `/api/eval/**` routes, deliberately (§1.4) |
| geography seeds 202 tags | **201**, matching qa exactly (§1.5) |
| `keyword_vocab` "0 id mismatches" left df/idf unexamined | **all 298,206 shared tokens identical in `df` and `idf`**; `avgdl` identical. No BM25 skew (§1.7) |
| — | prod has **never ingested a document**; intake queue empty (§1.2) |
| — | `(document_id, chunk_index)` verified unique; `embedding_model` uniform; qa has **0** `needs_reembed` tags (§1.7) |


---

## 11. Execution record — 2026-09-19/20 (completed)

Release merge commit `666c518` (two parents: `c1af292` + `51cf9f9`). All three production services
run image `666c518`. `git log --no-merges origin/qa..origin/production` is empty — the merge-commit
invariant held.

### Timeline
| time (UTC) | event |
|---|---|
| 23:1x | Phase 0 — both workers scaled to 0; intake empty; no in-flight jobs either side |
| 23:18 | Snapshot `pre-release-2026-09-19` available (rollback floor) |
| 23:2x | Per-table dumps (~865 MB) + baseline fingerprint captured |
| 23:4x | Phase 3 — 5 migrations applied in one transaction |
| 23:4x–23:5x | Phase 4 — data mirror, all objects matched |
| 23:51 | PR #427 merged (merge commit) → production deploy |
| 23:59 | Search-service booted: `201 documents`, `34791 chunks`, indexing complete in **1.2 s** |
| 00:03 | Worker restored on rev 4 / `666c518`; `build_all_embeddings: built 0` every tick |

### Gates
All green. Live image SHA verified on every service (not inferred from a green workflow).
Experts mode returned real topic matches (`Electric Vehicles` 0.359, `Electric School Buses` 0.344,
`Electric Mobility` 0.311), `degraded: []` — proving `tag_embeddings` landed correctly rather than
falling through to the silent `TOPIC_NO_MATCH` path. Author repair dry run: **0 planned changes**.
10 provenance rows written to `audit_log` under `source='release-2026-09-19'`.

### Corrections discovered DURING execution (rev 4 was wrong about these)

1. **Production's original 18 tags included a `topic` tag.** Actual breakdown: 7 doc_type, 9 office,
   1 program, **1 topic** (`ae3de125… | topic | Transport decarbonization`). §1.7's "8 doc_type,
   9 office, 1 program" described qa's facets, not prod's, and the error propagated into the
   assumption that prod had no topic tags.
2. **`document_tags` diverged by 65 prod-only rows, not 1.** 64 `llm` + the 1 known `external`.
   §1.9 compared source-bucket *counts* and the human/external sets by identity, but never the full
   `(document_id, tag_id)` set. The guard in the apply script caught it and aborted the transaction.
   Resolution: deleted all 65 (0 human rows affected — asserted in-transaction), consistent with
   D1/D4. qa-only was 1,201 (1,193 llm + 8 human); shared 948, of which 10 differed in attributes.
3. **`documents.updated_at` differed on 50 rows** after the 12-column copy. Copied it too, rather
   than accept a permanent "known benign mismatch" — that pattern is what trains operators to wave
   past a red gate (cf. H3). Final `documents` digest equals qa's exactly.
4. **The baseline `tags` digest could not include `description`** — that column arrives with
   `1787160000000`, so it does not exist pre-migration. The before-fingerprint therefore uses an
   identity-tuple digest valid on both schemas; the after-gate uses the full row digest once both
   schemas match. Stated here so the next operator does not compare across two instruments.
5. **`askwri` cannot `CREATE SCHEMA`** (`permission denied for database production`) — the same
   privilege wall that blocked `CREATE EXTENSION`. The staging-schema approach in §5 is not
   executable as written. Temp tables work and are better: session-scoped, so load + apply happen
   in one transaction and no staging debris can be left behind.
6. **Worker `desired_count = 0` is why terraform finally moved the service.** See §11.1.

### 11.1 The ingestion-worker task-definition mystery — partially solved

Terraform moved `aws_ecs_service.ingestion_worker` to revision 4 during this release, after
ignoring two previous deploys. The distinguishing condition: **the service was at
`desired_count = 0`**, so the update completed instantly with no task to replace.

Working hypothesis, consistent with all evidence but **not yet proven**: on 2026-09-02 terraform
pointed the service at revision `:3`, the new task failed to stabilize, and the **deployment
circuit breaker rolled it back to `:1`** — while `aws ecs wait services-stable` returned success,
because a completed rollback *is* a steady state. Revision `:3` is no longer registered.

Counter-evidence: when scaled 0 → 1 on revision 4 after this release, the worker booted cleanly
with no errors. So whatever failed in September either was specific to that image or has since
been fixed. **Do not close §8.1 on this evidence.** The durable fix is asserting the live image
SHA after every deploy (Phase 6 Gate 1), which catches the failure regardless of cause.

### Still owed
- §8.1 root cause (above). §8.2 `gpt-5.6-luna` is live on production and unevaluated — D5 accepted
  it deliberately; it has still never been measured against production documents.
- §8.3 `main` is still `7c91ffe` and still a live downgrade trigger.
- §8.4 search-service `/health` still returns 200 while initializing.
- Confirm with the eval-review owner that nothing consumed the seven removed gen-1
  `/api/eval/**` routes on production.
- Measured: search-service index load is **~1.2 s**, so the deploy's degraded-`/query` window is
  seconds, not minutes (closes §6 item 3).
- `/tmp/prod-backup-2026-09-19/` (~865 MB) can be deleted once confidence is established; the
  snapshot `pre-release-2026-09-19` is the durable floor.
