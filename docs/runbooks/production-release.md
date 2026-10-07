# Production Release Runbook — standing procedure

**Scope:** every intentional production release, including the data mirror.

**Last executed:** 2026-09-19 (release `666c518`). That release is recorded in full,
with its measurements and its surprises, in `production-release-2026-09-19.md`. This
file is the *reusable* procedure distilled from it. When the two disagree, this file wins.

---

## 0. The five things that have actually bitten us

Read these before anything else. Each one cost real time or real risk.

1. **Pushing or merging to `main` deploys production, ungated.** `main` is stale
   (`7c91ffe`) and would *downgrade* prod over a newer schema. A release is
   `qa` → `production` via PR. Never target `main`. This has caused two accidental
   production deploys (PR #360 on 2026-08-25, PR #395 on 2026-09-02).

2. **A green workflow does not mean a successful deploy.** The app service has
   `deployment_circuit_breaker { rollback = true }`. A completed rollback *is* a steady
   state, so `aws ecs wait services-stable` returns success and `/api/health` looks fine —
   and `/api/health` carries no build identity (it returns `npm_package_version`, not a SHA).
   **Always assert the live image SHA** (§6 Gate 1). This is the single highest-value check
   in the whole runbook.

3. **The ingestion worker does not reliably pick up new images.** It sat on task definition
   revision 1 / image `c1af292` from 2026-08-07 through two "successful" deploys.
   `--force-new-deployment` cannot fix this — it relaunches whatever the service already
   points at. Only `--task-definition` moves it. See §8.

4. **The search-service cannot report its own health.** It has no container health check
   (disabled deliberately in `ecs.tf`), it is not behind the ALB, and `/health` returns
   HTTP 200 while still initializing or degraded. ECS "stable" proves nothing. Read the
   boot log instead (§6 Gate 2).

5. **`askwri` cannot `CREATE SCHEMA` or `CREATE EXTENSION`** (`permission denied for
   database production`). Do not plan a staging schema. Use temp tables — session-scoped,
   so load and apply happen in one transaction and no debris can be left behind. Extensions
   require the RDS master role.

---

## 1. Reconcile branches — `qa` must be the superset

```bash
git fetch origin
git log --oneline origin/qa..origin/main                 # expect EMPTY
git log --no-merges --oneline origin/qa..origin/production  # expect EMPTY
git diff --shortstat origin/production origin/qa         # the delta this release ships
```

**`--no-merges` is required on the second check.** The plain form is never empty after any
release, because a `qa`→`production` merge commit is by construction not an ancestor of `qa`.
The older version of this runbook told you to expect an empty plain log; that was wrong and
cost a false alarm.

**Prove the merge is safe rather than assuming it:**

```bash
git merge-tree --write-tree origin/production origin/qa   # note the tree hash
git diff <that-tree> origin/qa                            # expect EMPTY
```

An empty diff means the merge tree equals qa's tree exactly, so CI on the merge commit is
the same CI that already passed on qa.

## 2. Discover pending ops items — run EVERY release

```bash
# 1. Pending migrations against the prod DB (authoritative, read-only):
./scripts/with-remote-env.sh production npm run typeorm -- migration:show \
  -d src/db/migration-data-source.ts

# 2. One-off data/repair scripts added since the last release:
git diff --name-only origin/production..origin/qa -- scripts/

# 3. Terraform deltas — BOTH directories. environments/ alone is not enough:
git diff origin/production..origin/qa -- terraform/

# 4. Deps (image rebuild handles these; verify only):
git diff --stat origin/production..origin/qa -- search-service/requirements.in package.json

# 5. Workflow/secret deltas (a new GitHub secret is a preflight blocker):
git diff --stat origin/production..origin/qa -- .github/

# 6. Routes REMOVED by this release — external callers will 404:
git diff --diff-filter=D --name-only origin/production..origin/qa -- src/app/api/
```

**Diff against `origin/production`, not `origin/main`.** And when production is serving
something other than the `production` branch tip (it has happened twice), diff against the
**deployed** ref too — otherwise you will warn about routes that disappeared months ago and
miss the ones actually going away. On 2026-09-19 this exact error produced a warning about
`/api/why` and `/api/relates`, which were already gone, while the seven `/api/eval/**` routes
actually being removed went unmentioned.

**Terraform trap:** `git diff -- terraform/environments/` misses defaults changed in
`terraform/infrastructure/variables.tf`. On 2026-09-19 that hid a change of
`worker_llm_model` from `gpt-5-mini` to `gpt-5.6-luna`, which production inherits because
`production.tfvars` never sets it. Diff all of `terraform/`.

## 3. Freeze — BOTH environments

```bash
aws ecs update-service --cluster askwri-app-production-cluster \
  --service askwri-app-production-ingestion-worker --desired-count 0 --region us-east-2
aws ecs update-service --cluster askwri-app-qa-cluster \
  --service askwri-app-qa-ingestion-worker --desired-count 0 --region us-east-2
```

**qa's worker too.** qa is the copy *source*, and both environments share
`s3://askwri-data/intake/` — so a live qa worker can ingest a dropped file and mutate the
source mid-copy. Freezing only production is half a freeze.

These stick: all three services have `lifecycle { ignore_changes = [desired_count] }`, so
Terraform will never write `desired_count` back. **Nothing in the deploy restores them** —
§8 does, by hand. (An older version of this runbook claimed Terraform re-asserts it. It does not.)

Then confirm: both `runningCount: 0`, `s3://askwri-data/intake/` empty, and no `queued`/
`running` rows in `ingestion_jobs` on either side.

## 4. Backup — snapshot, not pg_dump

```bash
aws rds create-db-snapshot --db-instance-identifier askwri-db1 \
  --db-snapshot-identifier pre-release-$(date -u +%Y-%m-%d) --region us-east-2
aws rds wait db-snapshot-available --db-snapshot-identifier pre-release-$(date -u +%Y-%m-%d) \
  --region us-east-2
```

One server-side call, no egress, covers **both** databases (they share one instance).

**Do not take a full `pg_dump`.** `document_chunks` alone dumps to ~830 MB (35k rows × a
1536-dim dense vector plus a sparsevec). Streaming that off a `db.t4g.small` that also
serves live production traffic *and* all of qa evicts the buffer cache the HNSW scans
depend on. `askwri-db1` is single-AZ with 7-day PITR, so a snapshot plus PITR is a strictly
better floor than dumps that §5 admits cannot be restored without a truncate.

Small per-table dumps are still worth taking for surgical restores:

```bash
mkdir -p /tmp/prod-backup-$(date -u +%Y-%m-%d)
for t in documents document_chunks document_summaries document_tags tags \
         document_texts document_collections ingestion_jobs; do
  if [ -n "$(./scripts/with-remote-env.sh production psql -X -t -A \
              -c "select to_regclass('public.$t')")" ]; then
    ./scripts/with-remote-env.sh production pg_dump --no-owner --no-acl --data-only \
      --table=public.$t > /tmp/prod-backup-$(date -u +%Y-%m-%d)/$t.sql
  fi
done
```

The `to_regclass` guard matters: `pg_dump --table=` on a nonexistent table **exits 1** and
leaves a 0-byte file. Without the guard you are training yourself to read a failed backup
as a successful one.

## 5. Baseline fingerprint

```bash
./scripts/fingerprint-corpus.sh production qa > /tmp/fingerprint-before.txt
```

This is the instrument the release is gated on. Run it again after the mirror (§6 Gate 3)
and compare. `verify-corpus-parity.sh` compares scalar **counts** and cannot see a document
whose text or vectors diverged while the row count held — which is exactly what happened
before this procedure existed.

**Instrument rule.** `tags.description` does not exist before migration `1787160000000`, so
a digest including it is not computable pre-migration. The script emits `tags_identity`
(valid on any schema, use across a migration) and `tags_full` (use only once both sides
share a schema). **Never compare one against the other** — that is comparing two harnesses.

## 6. Order of operations

**Migrations → data mirror → build_search_vocab → deploy.** Each step depends on the
previous one.

### Step 1 — migrations

```bash
./scripts/with-remote-env.sh production npm run migration:run
./scripts/with-remote-env.sh production npm run typeorm -- migration:show \
  -d src/db/migration-data-source.ts   # expect all [X]
```

**All pending migrations run in ONE transaction** (TypeORM's default
`migrationsTransactionMode: "all"`; nothing overrides it). A failure rolls back *all* of
them and `migration:show` still lists them all as pending. There is no partial state to
diagnose and no "resume from migration three" — read the error, fix, re-run.

Migrations so far have been additive, and the currently-serving old code does not read the
new tables (boot touches only `documents`, `document_chunks`, `document_texts`), so the
old-code-on-new-schema window is safe. If a migration is ever destructive, stop and follow
its own plan doc.

### Step 2 — the data mirror

```bash
./scripts/mirror-qa-to-production.sh                   # dry run: real statements, rolled back
./scripts/mirror-qa-to-production.sh --apply           # commit
```

The dry run executes the actual statements inside a transaction and rolls back, so its
counts and guard results are exact rather than predictions. Read them before applying.

**If a guard trips, it is telling you something true.** On 2026-09-19 the `document_tags`
guard expected 1 prod-only row and found 65 — 64 LLM classifications production had made
that qa did not have. Nobody knew, because every previous comparison looked at source-bucket
*counts* rather than the actual `(document_id, tag_id)` sets. Investigate before overriding.

**Deleting an `external` row requires `--allow-external-deletes N`** and is a recorded
exception to the CLAUDE.md write-ownership rule.

**`human` rows are protected on both paths.** Deletion is the obvious one, but the upsert is
the subtle one: it rewrites `source`/`confidence`/`model_version`/`status` on every shared
key, so a pair that is `human` on production and `llm` on qa would be silently demoted. The
script aborts if any shared key would have a production `human` row overwritten by a
non-human source, *and* the `ON CONFLICT … WHERE` clause independently refuses the write.
Neither can be satisfied by a flag.

### Step 3 — search vocabulary

```bash
./scripts/with-remote-env.sh production bash -c \
  'cd search-service && ./venv/bin/python -m scripts.build_search_vocab'
```

**After** the mirror, never before — it reads `documents.title/title_en WHERE
status='searchable'`, `tags WHERE facet='topic'`, and `tag_aliases`. Delete-then-insert,
idempotent, re-runnable.

**Set expectations honestly:** `search_vocab` has exactly one consumer, `spell_suggest`, via
`build_understanding`, which runs only when `query_understanding_enabled` is true. That
defaults to `false` and production's task definition carries no `QUERY_*` variable. **Nothing
on production reads this table today.** Building it is correct preparation for enabling the
flag later; there is no did-you-mean behaviour to probe, and its absence is not a failure.

### Step 4 — deploy

```bash
gh pr create --base production --head qa --title "Release <date>: <headline>"
# first line of the body MUST be `Refs #N` or `No issue — <reason>`
gh pr merge <N> --merge        # MERGE COMMIT. Not squash, not rebase.
gh run watch
```

**`--merge` explicitly.** Squash and rebase are both enabled on this repo and GitHub's UI
remembers the last method used per user. Either one creates a non-merge commit on
`production` that is not an ancestor of `qa`, permanently breaking the `--no-merges`
invariant in §1 and invalidating the merge-tree proof.

Expect **two rollouts per service**: `terraform apply` updates the service resource (one
rollout), then the deploy job issues `--force-new-deployment` (a second). That is normal.

## 7. Verification gates — in this order

### Gate 1 — live image SHA (do this first; it is the one that catches a silent rollback)

```bash
for s in service search-service ingestion-worker; do
  TD=$(aws ecs describe-services --cluster askwri-app-production-cluster \
    --services askwri-app-production-$s --query 'services[0].taskDefinition' \
    --output text --region us-east-2)
  echo "$s -> $(aws ecs describe-task-definition --task-definition "$TD" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text --region us-east-2)"
done
```

All three must show the release merge SHA. Anything else means a circuit-breaker rollback
that every other signal reported as success.

### Gate 2 — search-service actually booted

```bash
aws logs tail /ecs/askwri-app-production-search-service --since 15m --region us-east-2
```

Must contain `✅ Postgres-backed retrieval ready (N documents)` and
`📊 Keyword lane: Postgres sparse (N chunks)`. `N documents` should equal the `searchable`
count, and `N chunks` will be *lower* than total chunks because withdrawn documents are
excluded. Index load measured at **~1.2 s** on 2026-09-19, so the degraded-`/query` window
inside a deploy is seconds.

### Gate 3 — content parity

```bash
./scripts/fingerprint-corpus.sh production qa
```

All gated objects must report `MATCH`. `keyword_vocab` and `search_vocab` differ benignly
(canary tokens on one side; vocab rebuilt at different times) and the script labels them so.
The script also verifies that **shared `keyword_vocab` tokens have identical `df`/`idf`** —
if they do not, copied sparse vectors are scoring on a different scale and the sparse lane
needs rebuilding.

### Gate 4 — embedding completeness (this is what keeps the worker quiet)

```sql
select count(*) from tags t
 where t.facet in ('topic','geography') and t.taxonomy_version='v1'
   and not exists (select 1 from tag_embeddings te where te.tag_id=t.id);   -- MUST be 0
```

**`needs_reembed` is the wrong lever.** The worker runs `build_all_embeddings` every tick
(`worker/stages/embed_tags.py`), which fires on a **missing `tag_embeddings` row** and has
no flag filter at all. A tag with the flag clear but no embedding row still triggers a
Bedrock call. Do not restore the worker until this query returns 0.

### Gate 5 — real queries

```bash
curl -s https://www.askwri-app.org/api/health
curl -s -X POST https://www.askwri-app.org/api/llamaindex \
  -H 'Content-Type: application/json' \
  -d '{"query":"What have we published on hydrogen?","mode":"cite"}'
```

Plus: a newly-promoted document is retrievable, and a withdrawn one is not.

### Gate 6 — experts mode (probe the substance, not the status code)

```bash
curl -s -X POST https://www.askwri-app.org/api/experts \
  -H 'Content-Type: application/json' \
  -d '{"query":"electric bus adoption in China","top_n":5}'
```

Assert **non-empty `understanding.matched_topics`** and **non-empty `people`**.
`/experts` has no feature flag — it is publicly reachable the moment the release merges —
and it **degrades silently** if `tag_embeddings` is wrong, falling through
`isTopicDegraded` / `TOPIC_NO_MATCH` to return plausible-looking, topic-less results with a
200. A status code proves nothing here.

## 8. Restore the workers — by hand, in this order

```bash
# qa first: pure undo of the §3 freeze
aws ecs update-service --cluster askwri-app-qa-cluster \
  --service askwri-app-qa-ingestion-worker --desired-count 1 --region us-east-2

# production: find the revision terraform registered during the deploy, and POINT AT IT
aws ecs list-task-definitions --family-prefix askwri-app-production-ingestion-worker \
  --sort DESC --max-items 3 --region us-east-2
aws ecs update-service --cluster askwri-app-production-cluster \
  --service askwri-app-production-ingestion-worker \
  --task-definition <newest> --desired-count 1 --region us-east-2
```

**`--task-definition` is required.** `--force-new-deployment` relaunches whatever the
service already points at and cannot change its image. This is why the worker ran August
code through two releases.

Only after **Gate 4** passes. Then watch it for ten minutes:

```bash
aws logs tail /ecs/askwri-app-production-ingestion-worker --follow --region us-east-2
```

Healthy looks like `build_all_embeddings: built 0 tag embedding(s)` every tick. If it starts
building, Gate 4 was wrong — scale back to 0 and re-check `tag_embeddings`.

## 9. Close out

1. **Author-format repair — dry run must plan 0 changes:**

   ```bash
   ./scripts/with-remote-env.sh production npm run repair:author-formats
   ```

   Expect `Candidates: N docs -> 0 planned`. **The `audit_log` count is not a valid probe**
   for this. A raw SQL copy of `documents.authors` writes no audit row, so that count stays
   0 forever and regenerates this item at every future release. The script is idempotent by
   shape, so a 0-change dry run is the real proof of discharge.

2. **Write provenance rows.** The mirror changes thousands of rows with no operator behind
   them. Insert one `audit_log` row per copied table under
   `source='release-<date>'` recording counts and before/after digests, so production's
   history explains itself. See the 2026-09-19 record for the shape.

3. **Confirm the merge invariant:** `git log --no-merges origin/qa..origin/production` → empty.

4. **Clean up:** `/tmp/prod-backup-<date>/` once confidence is established. The snapshot is
   the durable floor.

## 10. Rollback

### Code — the image is pinned by SHA, never `:latest`

All six container definitions use `:${var.image_tag}`. **Re-tagging `:latest` does nothing.**
(An older version of this runbook said to do exactly that.)

- **Preferred:** re-run `deploy-production.yml` via `workflow_dispatch` from the previous ref.
- **Or:** `terraform apply -var="image_tag=<sha>"` **from CI, never a laptop.** A local apply
  lacks the `TF_VAR_*_secret_env` GitHub Environment secrets and would register task
  definitions with **no credentials**.
- **Do not `git revert` the merge.** That lands production on the previous `production` tip,
  which may be *older* than what production is actually running, and may lack routes the
  current deployment has.
- Rollback targets are not uniform across services — check each one's current image first.

### Schema

`npm run migration:revert` reverts one migration per invocation, newest first. Read each
`down()` first: reverting `1787160000000` **drops `tag_embeddings`, `tag_aliases` and the new
`tags` columns**, taking any copied taxonomy with them.

### Data — never `TRUNCATE`

`TRUNCATE` on an FK-referenced table errors regardless of whether the referencing tables are
empty, and `documents` is referenced by eight FKs. The `CASCADE` an operator reaches for
under pressure destroys **`document_texts`** — the OCR cache the entire "zero re-ingest cost"
premise depends on — plus `document_collections`, `ingestion_jobs` and `reclassify_jobs`.

The mirror is **UPDATE-only** for `documents`, `document_chunks` and `document_summaries`, so
the inverse is surgical: restore the per-table dump into a temp table and `UPDATE … FROM` the
affected keys. For the tables the mirror fills from empty, a plain `DELETE` is the inverse.

For anything worse: restore the snapshot (or PITR) into a **scratch instance** and copy
tables back. Never restore over a live instance.

## 11. Known qa-only deviations — do not "helpfully" sync these

| Deviation | Where | Why prod differs |
|---|---|---|
| `QUERY_UNDERSTANDING_ENABLED` | `qa.tfvars` | query-understanding lane is eval-gated on qa; prod stays deterministic-first |
| `QUERY_EXPANSION_LANES_ENABLED` | `qa.tfvars` | same lane |
| `QUERY_UNDERSTANDING_LLM_ENABLED` | `qa.tfvars` | P3 LLM sidecar |
| `DEEP_RESCUE_MAX` | `qa.tfvars` | tuning under eval on qa |
| `EXPANSION_FACETS` | `qa.tfvars` | geo lane; flag off on prod |
| translation pairs | flag off everywhere | sweep → review queue → eval gate first |
| `container_memory` 1024 (prod) vs 512 (qa) | tfvars | prod has *more*. The cutover runbook's "qa runs 2048" is stale |

`worker_llm_model` is **not** in this table — it is a `variables.tf` default that production
silently inherits. Pin it explicitly in `production.tfvars` if you want it to be a decision
rather than a side effect.

## 12. Standing items not yet discharged

- **Root-cause the worker's task-definition pinning.** Needs `terraform plan` /
  `terraform state show` against `production.backend.hcl`. Until it is understood, §8's
  manual repoint is load-bearing every release.
- **`main` is still a live downgrade trigger.** Either fast-forward it to the release commit
  (fires one more deploy, deliberately) or add a required reviewer to the `production` GitHub
  Environment. The Environment currently has `protection_rules: []` and the `production`
  branch has no protection at all — **the merge button is the deploy button.** The durable
  fix is the Environment reviewer.
- **`/health` on the search-service should 503 while initializing or degraded.** Until then,
  ECS "stable" and the deployment circuit breaker are blind on the service that matters most.
- **Secrets Manager migration.** `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `DB_PASSWORD`,
  `SESSION_SECRET` sit in task-definition `environment` entries rather than a `secrets` block.
- **`worker_llm_model = gpt-5.6-luna`** has been live on production since 2026-09-19 and has
  never been evaluated against production documents.
- **Dead env vars** with no code reference: `HOTJAR_ID` and `LLAMA_CLOUD_API_KEY` on the
  search-service, `LLAMA_CLOUD_API_KEY` and `NEXT_PUBLIC_HOTJAR_ID` on the app. Removing them
  means editing GitHub Environment secrets and letting Terraform re-render, which triggers a
  redeploy — so it is a separate, post-release change.
