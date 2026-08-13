# QA Push + Deploy Runbook — first push of the document-management work

**Scope:** the first `git push origin qa` of the local qa line (PR #240: Phase 0 store +
migration, Phase 1 ingestion worker, Phase 2 admin UI, sparse keyword lane, review-fix
waves, admin UX + metadata-provenance work). Follow the steps **in order** — the ordering
is the point of this runbook.

**Companion docs:** [phase0-cutover.md](phase0-cutover.md) (RDS preflight, corpus migration,
local dev), [docs/document-management.md](../document-management.md) (as-built reference),
[docs/plans/2026-06-11-keyword-lane-replacement-design-note.md](../plans/2026-06-11-keyword-lane-replacement-design-note.md)
(sparse-lane evidence).

---

## Why ordering matters (read first)

The deploy workflow (`.github/workflows/deploy-qa.yml`, triggered by any push to `qa`)
contains **no migration step and no plan-only Terraform gate**: it runs Jest + build, builds
and pushes both Docker images, then `terraform plan` + `terraform apply -auto-approve` in the
same job, then `aws ecs update-service --force-new-deployment` for all three services
(`askwri-app-qa-service`, `askwri-app-qa-search-service`, `askwri-app-qa-ingestion-worker`).

The new code defaults to `KEYWORD_BACKEND=sparse` (`search-service/app/config.py`). The
sparse boot path has a hard guard: if no searchable chunk has a populated
`document_chunks.sparse` vector, boot raises
`KEYWORD_BACKEND=sparse but document_chunks.sparse is unpopulated`. The service still
accepts connections, but `/health` reports `degraded - indexing error` and every `/query`
returns 500 (`Service not properly initialized`).

Therefore the safe sequence is:

1. **Migrate RDS** (Step 2) — the backfill script needs the `keyword_vocab` /
   `keyword_corpus_stats` tables from migration `1781310000000`.
2. **Run the sparse backfill against RDS** (Step 3).
3. **Then push** (Step 4) — services come up against an already-prepared schema.

If you cannot run the backfill before pushing, use the fallback in Step 5 instead
(deploy with `KEYWORD_BACKEND=memory`, flip to sparse after backfilling).

---

## Step 1: Preflight

### 1a. GitHub secrets

All three are read by both `deploy-qa.yml` and `deploy-production.yml` and land as
**plain-text environment variables** in the ECS task definitions (JSON-decoded by
`terraform/infrastructure/ecs.tf`; SSM Parameter Store is deferred):

| GitHub secret | Terraform var | Feeds | Must contain |
|---|---|---|---|
| `INGESTION_WORKER_ENV` | `ingestion_worker_secret_env` | ingestion-worker task env | **NEW — create it.** JSON: `{"DATABASE_URL": "postgresql://…?sslmode=require", "OPENAI_API_KEY": "sk-…"}` |
| `ASKWRI_APP_ENV` | `askwri_app_secret_env` | Next.js task env | Existing JSON; **add** `SESSION_SECRET` (≥ 32 chars, generate with `openssl rand -hex 32`) and optionally `ADMIN_API_TOKEN` (machine-to-machine admin auth) |
| `SEARCH_SERVICE_ENV` | `search_service_secret_env` | search-service task env | Verify it has `DATABASE_URL` and `RETRIEVAL_BACKEND=postgres`. A `KEYWORD_BACKEND` override (Step 5 fallback) also goes here |

A missing/empty secret decodes to `{}` (`try(jsondecode(...), {})`) — the deploy succeeds
but the task boots without those vars, so check these **before** pushing.

### 1b. RDS preflight

Same as [phase0-cutover.md Step 1](phase0-cutover.md#step-1-rds-preflight): `vector`
extension available at ≥ 0.7.0 (the `sparsevec` column type requires it).

### 1c. Check which migrations RDS already has

```bash
DATABASE_URL="postgresql://user:password@rds-host:5432/db?sslmode=require" \
  npm run typeorm -- migration:show -d src/db/migration-data-source.ts
```

Expected pending (`[ ]`): five migrations, `Migration1781300000000` through
`Migration1781340000000`.

If `Migration1781280000000` / `Migration1781290000000` are **also** pending, the Phase 0
cutover never ran against this RDS instance — stop and execute
[phase0-cutover.md Steps 1–4](phase0-cutover.md#production-cutover--step-by-step) (schema +
corpus migration script) first, then return here.

`DATABASE_SSL` note: the shell-prefixed `DATABASE_URL` wins over `.env` (dotenv never
overrides existing env vars), but a local `.env` with `DATABASE_SSL=false` still disables
SSL in `src/db/data-source.ts`. When targeting RDS, also export `DATABASE_SSL=true`
(any value other than `false`), and `DATABASE_SSL_REJECT_UNAUTHORIZED=false` if the RDS CA
is not in your local trust store.

---

## Connecting to a deployed database (use this everywhere below)

`./scripts/with-remote-env.sh <qa|production> <command...>` reads host, port, user,
database and password from that environment's ECS task definition, builds a correct
`DATABASE_URL` (percent-encoded password, `?sslmode=require`), forces `DATABASE_SSL=true`,
and also exports `PG*` so bare `psql` works:

```bash
./scripts/with-remote-env.sh qa npm run typeorm -- migration:show -d src/db/migration-data-source.ts
./scripts/with-remote-env.sh qa npm run migration:run
./scripts/with-remote-env.sh qa psql -c 'select count(*) from documents'
ADMIN_PASSWORD='a password' ./scripts/with-remote-env.sh qa npm run seed:admin -- alice
```

It prints the target it resolved (`→ askwri@…/qa`) before running anything, which is the
cheapest guard against running a QA command against production. The literal
`DATABASE_URL=...` forms shown below still work; prefer the wrapper.

---

## Step 2: Run migrations against RDS

**Run in a quiet window** — migration `1781300000000` starts by **deleting** duplicate open
(queued/running) `ingestion_jobs` rows (keeps a running job over a queued one, then the
newest per document) before creating the partial unique index
`ingestion_jobs_one_open_per_doc`. It also tightens the `documents` FK to
`ON DELETE CASCADE`. Migrations `1781320000000`–`1781340000000` additionally rewrite
`documents` / `document_summaries` rows (data fixes, see below). Nothing should be writing
ingestion jobs or editing documents while they run. (On first deploy neither the worker nor
the admin UI exists yet, so this is trivially satisfied.)

```bash
DATABASE_URL="postgresql://user:password@rds-host:5432/db?sslmode=require" npm run migration:run
```

Expected: five `Migration<timestamp> has been executed successfully.` lines,
`1781300000000` through `1781340000000`.

What they do:

- `1781300000000` — open-job dedupe + unique index + `ingestion_jobs.document_id` FK
  becomes `ON DELETE CASCADE`.
- `1781310000000` — `keyword_vocab` and `keyword_corpus_stats` tables (sparse keyword lane).
- `1781320000000` — drops the dead `documents.abstract` column; adds `authors` / `url` /
  `date_published` (backfilled from the CSV `source_metadata`); fixes 37 junk titles
  ("Pre-EM" / "Not available"); relabels 33 mislabeled summaries to `language='en'` (frees
  the native-language slots so the worker regenerates real native summaries on the next
  re-ingest); backfills `title_en`; unique partial index on `documents.content_hash`.
- `1781330000000` — `documents.metadata_source` jsonb (per-field provenance
  `external`/`llm`/`human`, read by the worker's re-ingest overwrite rules) + backfill.
- `1781340000000` — data fix: normalizes camelCase `metadata_source` keys written by the
  pre-fix CSV import to the canonical snake_case names. Idempotent.

---

## Step 3: Sparse keyword backfill against RDS

```bash
cd search-service
DATABASE_URL="postgresql://user:password@rds-host:5432/db?sslmode=require" \
  ./venv/bin/python -m scripts.build_sparse_keyword
```

Needs only `DATABASE_URL` (no S3, no OpenAI). Expected output ends with
`wrote <N> vectors in …; searchable chunks with sparse: <M>; vocab <V>; avgdl <…>`
(~1–2 min on 30k chunks; local reference run: 30,526 vectors, vocab 184,395, avgdl 192.5).

Notes:

- The script covers **ALL documents regardless of status** (weights don't depend on
  status; retrieval filters `status='searchable'` per query), so docs promoted later are
  already keyword-ready.
- It writes everything in **one atomic transaction** and is idempotent — safe to re-run.
- **The ingestion worker must be idle during any refresh run** (a concurrent embed stage
  races the vocab/stats writes). On first deploy there is no worker yet; for later
  refreshes, scale `askwri-app-qa-ingestion-worker` to 0 first.

**`SPARSE_EN_HANDLES`** (spec 2026-07-26; **qa activated 2026-07-26** — flag-on
backfill executed, floor 0.09 re-confirmed, see
`docs/plans/2026-07-26-sparse-en-handles-gate-results.md`): if this flag is on,
it must be set consistently in **both** the backfill operator's shell above
**and** the ingestion-worker task env — otherwise the next re-ingest silently
strips the handles the backfill just added. The worker-side setting lives in
`terraform/environments/<env>.tfvars` → `ingestion_worker_environment_variables`
(non-secret; this is where qa sets it). The `INGESTION_WORKER_ENV` secret JSON
also lands in the same task env but is for actual secrets — don't put the flag
in both. Two other gotchas:

- `scripts/sparse_parity_check.py` only guards the env of the process running it.
  After a flag-on rebuild, running parity from a flag-off shell will legitimately
  fail — only run parity against a flag-off rebuild.
- A flag-on-then-off rollback leaves residual, unused rows in `keyword_vocab`.
  This is harmless: their dimensions are zero-weight in every chunk's sparse
  vector, and `document_chunks.sparse` itself is byte-identical to a flag-off
  rebuild.

Verify:

```sql
SELECT count(*) FROM document_chunks dc
JOIN documents d ON d.id = dc.document_id
WHERE d.status = 'searchable' AND dc.sparse IS NOT NULL;
-- expected: every searchable chunk (0 rows with sparse IS NULL)
SELECT n_chunks, avgdl, sparse_dim, built_at FROM keyword_corpus_stats;
```

---

## Step 3b (optional, per environment): parse-cache backfill

Only when you are about to run a bulk re-ingest (e.g. a prompt-tuning
`reingest_all`) and want it to perform **zero OCR calls**. Skip it otherwise —
the parse cache works without this; new parses stamp themselves, and unstamped
rows simply miss.

**Environment-specific, deliberately not a migration:** the stamp must name the
parser that actually produced each row's text, and that differs by environment
(qa has been fully Mistral-parsed since 2026-07-23; production is not). Never
stamp an environment `mistral` without confirming its corpus was parsed that
way — a wrong stamp makes the cache serve stale pypdf text forever.

**The stamp does not track parse *code* version.** If the change you are about
to deploy alters what `_parse_pdf_pypdf`/`_parse_pdf_mistral` EMIT (the
2026-07-22 per-page boundary fix is the precedent), a stamped corpus will
cache-hit and silently keep the old-format text. In that case skip this step and
run the campaign with `FORCE_REPARSE=true` instead. Same for an OCR upgrade
delivered under the unchanged `mistral-ocr-latest` alias.

```sql
-- qa ONLY, after confirming qa's corpus is all-Mistral.
-- Substitute the worker's live MISTRAL_OCR_MODEL for <model>.
UPDATE document_texts dt
SET parsed_content_hash = d.content_hash,
    parse_backend = 'mistral', parse_model = '<model>'
FROM documents d
WHERE d.id = dt.document_id
  AND d.content_hash IS NOT NULL
  AND d.source_metadata IS NULL
  AND jsonb_array_length(dt.page_boundaries) > 0;
```

Two rows are deliberately left unstamped, and both keep re-parsing:

- NULL `content_hash` (CSV-era imports) — nothing to compare bytes against.
- Empty `page_boundaries` — the signature of parse's title+summary fallback for
  documents with no retrievable PDF. That text was never OCR'd, so stamping it
  `mistral` would make the cache serve non-PDF text as OCR output forever. Every
  genuinely parsed row has at least one boundary.

Rollback / invalidate the whole cache:

```sql
UPDATE document_texts
SET parsed_content_hash = NULL, parse_backend = NULL, parse_model = NULL;
```

For a one-off forced re-OCR without touching data, set `FORCE_REPARSE=true` on
the worker instead. That is not an instant toggle: it lives in
`terraform/environments/<env>.tfvars` →
`ingestion_worker_environment_variables`, so it costs a `terraform apply` and a
task-definition redeploy each way.

Verify — the `GROUP BY` only echoes what the UPDATE just wrote, so it cannot
catch a wrong `<model>` string. Confirm the cache actually hits by re-ingesting
one document and looking for `parse cache hit, skipping OCR` in the worker log:

```sql
SELECT parse_backend, parse_model, count(*)
FROM document_texts GROUP BY 1, 2;
```

---

## Step 4: Push qa

```bash
git push origin qa
```

This triggers `Deploy to QA`: test → build-and-push (app + search-service images, tagged
with the commit short SHA **and** `latest`) → terraform plan+apply → force-new-deployment
of all three ECS services → `aws ecs wait services-stable`.

Watch it:

```bash
gh run watch
```

Deploy-window note: between `terraform apply` and the new tasks stabilizing, the **old**
app/search-service code briefly runs against the **new** schema. All five new migrations
only touch tables the Phase 0 migrations created (`documents`, `document_summaries`,
`ingestion_jobs`, the keyword tables), which the currently deployed pre-Phase-0 code never
reads, so this window is safe.

---

## Step 5: Fallback — deploy first, flip to sparse later

Only if Step 3 could not run before the push:

1. Add `"KEYWORD_BACKEND": "memory"` to the `SEARCH_SERVICE_ENV` GitHub secret JSON
   **before pushing**. The memory backend hydrates the legacy in-memory BM25 index from
   Postgres chunks at boot — no sparse vectors needed.
2. Push (Step 4) and verify `/health` shows `keyword_backend=memory`.
3. Run Step 3 (backfill) — scale the worker to 0 first.
4. Remove the `KEYWORD_BACKEND` entry from `SEARCH_SERVICE_ENV` and redeploy
   (re-run the workflow via `gh workflow run deploy-qa.yml` or push an empty commit).

---

## Step 6: Seed the admin user (against QA RDS)

```bash
# The password goes in via env or stdin, never as an argument — an argument
# lands in shell history, in `ps`, and in npm's lifecycle banner.
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD
DATABASE_URL="postgresql://user:password@rds-host:5432/db?sslmode=require" \
  npm run seed:admin -- <username>
unset ADMIN_PASSWORD
```

Expected: `Created admin user '<username>'` (re-running with an existing username resets
its password and re-activates it). **Known, accepted limitation:** the password lands in
your shell history — clear it or prefix the command with a space if your shell honors
`HIST_IGNORE_SPACE`.

---

## Step 7: Verify

The search-service is **not** on the ALB (service-discovery only:
`search-service.askwri-app-qa.local:8000`), so probe it from inside a task via ECS exec
(`enable_execute_command` is on; the image has curl):

```bash
TASK=$(aws ecs list-tasks --cluster askwri-app-qa-cluster \
  --service-name askwri-app-qa-search-service --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster askwri-app-qa-cluster --task "$TASK" \
  --container askwri-app-qa-search-service --interactive \
  --command "curl -s http://localhost:8000/health"
```

Checklist:

1. **`/health`** → `"status": "healthy"`, `"keyword_backend": "sparse"`,
   `"retrieval_backend": "postgres"` (the two backend fields are new in this push — their
   absence means an old image is still running).
2. **`/query` smoke** (same exec session):
   `curl -s -X POST http://localhost:8000/query -H 'Content-Type: application/json' -d '{"query": "deforestation in the Amazon"}'`
   → 200 with a non-empty `results` array. Then a query through the web UI.
3. **Admin login** at `https://qa.askwri-app.org/admin` with the Step 6 credentials →
   lands on the admin shell; `/admin/review`, `/admin/documents` render.
4. **Worker poll loop**:
   `aws logs tail /ecs/askwri-app-qa-ingestion-worker --follow` → periodic poll/sweep log
   lines, no crash loop.
5. **Audit rows**: make one admin mutation (e.g. edit a document title in
   `/admin/documents/<id>`), then:
   ```sql
   SELECT actor_user_id, source, action, entity_type, at
   FROM audit_log ORDER BY at DESC LIMIT 5;
   ```
   → a fresh `source='human'` row for the mutation.

---

## Step 8: Rollback (per step)

| What broke | Rollback |
|---|---|
| Sparse keyword lane (bad rankings, boot failures) | Env flip: set `KEYWORD_BACKEND=memory` in `SEARCH_SERVICE_ENV` and redeploy. The legacy in-memory BM25 lane is intact; it hydrates from Postgres chunks at boot. (Memory-mode caveat: lifecycle changes then need `POST /reindex` — see document-management.md §4.) |
| Schema | `DATABASE_URL=… npm run migration:revert` reverts **one migration per invocation** (run up to five times to undo all new ones; newest — `1781340000000` — reverts first). Caveats: `1781300000000`'s `down` restores the `ON DELETE SET NULL` FK and drops the unique index, but the duplicate open jobs its `up` **deleted are not restorable**. `1781320000000`'s `down` drops the `authors`/`url`/`date_published` columns (losing any edits made since) and its title/summary data fixes are **one-way**. |
| Bad image / bad code | Task definitions pin `:latest`, and every deploy also tags the image with the git commit short SHA. Re-point `latest` at the last good SHA in ECR, then force a new deployment: |

```bash
# for each of askwri-app-qa and askwri-app-qa-search-service:
MANIFEST=$(aws ecr batch-get-image --repository-name askwri-app-qa \
  --image-ids imageTag=<previous-short-sha> --query 'images[0].imageManifest' --output text)
aws ecr put-image --repository-name askwri-app-qa --image-tag latest --image-manifest "$MANIFEST"
aws ecs update-service --cluster askwri-app-qa-cluster \
  --service askwri-app-qa-service --force-new-deployment
```

(Or `git revert` + push, which rebuilds and redeploys through the normal pipeline.)

---

## Translation pairs rollout (issue #325)

The `document_relations` table and worker suggestion hook ship inert — the table is
empty and `translation_pairs_enabled` is OFF by default. Activating retrieval
filtering is a separate, eval-gated ops step:

1. **Deploy + migrate.** Push qa (`askwri-app-qa`, `askwri-app-qa-search-service`) and
   run `npm run migration:run` against qa RDS (Step 2). Migration `1786579200000`
   creates `document_relations`; nothing reads it yet.

2. **Seed suggestions.** On the search-service task (or a shell with the venv +
   `DATABASE_URL`), run the sweep:
   ```bash
   cd search-service && ./venv/bin/python -m scripts.sweep_translation_pairs            # dry run — review the candidate count
   cd search-service && ./venv/bin/python -m scripts.sweep_translation_pairs --execute  # write suggested rows
   ```
   ~10 pairs land in the review queue. Idempotent — re-running after threshold
   changes only surfaces new candidates.

3. **Review queue.** Work `/admin/review` → "Translation suggestions": confirm or
   reject each, flipping direction where the detected-language proposal is wrong.
   The two #332 mislabeled pairs (stamped `zh`, text `en`) go to the zh reviewer —
   her stamps are reviewed by her, not overwritten. Confirmed edges still change
   nothing in retrieval while the flag is off.

4. **Eval gate (the activation decision).** With the flag still off, run both
   retrieval evals on the same harness:
   ```bash
   npm run eval:cite
   npm run eval:answer-retrieval
   ```
   Then re-run with `TRANSLATION_PAIRS_ENABLED=true` (export it for the eval
   process) and compare. Enable the flag in the search-service task definition only
   on acceptable deltas; #333 records the measured before/after.

5. **Rollback.** Unset `translation_pairs_enabled` (or remove it from the task
   definition). Retrieval reverts on the next query — no reindex, no data change.
   Confirmed/rejected rows stay (they are the review memory).

---

## Known gaps (accepted for this push)

- **No migration step in CI/CD** — schema changes are manual, per this runbook. A future
  iteration should gate the deploy on `migration:run`.
- **No plan-only Terraform gate** — the first `terraform plan` against real state happens
  inside the apply job of the deploy run itself (`pr-check.yml` only does
  `terraform validate` with `-backend=false`). Review the plan output in the Actions log
  *while* it applies, not before.
- **Old-code-on-new-schema window** during deploy (see Step 4 note) — safe this time
  because all five new migrations only touch Phase-0-created tables that the currently
  deployed (pre-Phase-0) code never reads.
- **Plain-text env secrets in task definitions** — the three secret JSONs become regular
  `environment` entries, visible to anyone with `ecs:DescribeTaskDefinition`. SSM
  Parameter Store migration is deferred.
