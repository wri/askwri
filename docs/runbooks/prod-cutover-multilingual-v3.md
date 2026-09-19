# Production cutover — multilingual-v3

> **STATUS: EXECUTED 2026-08-07.** Production now mirrors qa and is the primary
> ingestion path. This document is the as-built record. Everything below is
> what actually happened, with the places the pre-cutover plan was wrong called
> out inline — it stays in the repo because the same procedure runs again in the
> other direction (production → qa) once prod accumulates documents qa lacks.
>
> **Companion:** `docs/runbooks/qa-deploy-multilingual-v3.md` is the lab
> notebook — it records how the decisions were made. This runbook applies the
> result and does not repeat any of it.

## Verified end state (2026-08-07)

| | value |
|---|---|
| Migrations applied | 22 (was 7) |
| Documents | 202 active (179 `searchable`, 23 `needs_review`) + 4 `withdrawn` |
| Chunks | 35,449, all `cohere-embed-v4`, 0 null embedding, 0 null sparse |
| Parse cache | complete for every active document |
| Parity | all 20 probes matched qa (`scripts/verify-corpus-parity.sh`) |
| Telemetry preserved | 210 cite / 74 answer query logs, untouched |
| Services | app + search-service + **ingestion worker** (new) |

**Do not copy these numbers forward.** They were correct at cutover and start
going stale immediately — the previous revision of this file quoted "168
documents, 27,878 chunks" and was wrong within a fortnight. Derive them with
`scripts/verify-corpus-parity.sh`.

---

## The model

- **qa is the proving ground; the other environment mirrors it.** All
  investigation — parser bake-off, threshold derivation, gates — happens on qa.
  The target carries **zero** re-derivation. If a value looks worth re-checking,
  re-check it on qa.
- **Method: capability, then clone, then canary.** Deploy the proven code and
  config so the target can serve *and* ingest; copy the finished corpus as a
  literal data mirror; prove the going-forward pipeline with one real ingest.
- **Clone, not replay.** A data copy is self-consistent, takes minutes rather
  than hours, costs no OCR or embedding spend, and carries the parse-cache
  stamps so the target inherits a warm cache. A replay would additionally
  require re-running `build_sparse_keyword.py`; a clone does not, because
  `keyword_vocab`, `keyword_corpus_stats` and `document_chunks.sparse` travel
  together.

---

## Sequence

The pre-cutover plan ordered this deploy → migrate → clone. **That order is
wrong**, and running it cost a broken window on 2026-08-07. Prefer:

```
CREATE EXTENSION vector + "uuid-ossp"   (master user; NOT the app role)
  → migrations                           (target is still serving its old corpus)
    → clone corpus                       (target's search-service does not read these tables yet)
      → rebuild target secrets
        → deploy                         (flips RETRIEVAL_BACKEND=postgres onto a populated database)
          → force-new-deployment         (services do not reload the corpus on their own)
            → verify + canary
```

Deploying first puts the target's search-service into postgres mode against an
empty database. The loader raises at `search-service/app/main.py:645-649`, the
exception is swallowed at `main.py:721`, and the result is a service ECS reports
as **healthy** while every `/query` returns 500. The ingestion worker
simultaneously crash-loops on `relation "ingestion_jobs" does not exist`. Both
recover once the migrations and clone land, but only after a manual restart.

Running migrations and the clone *before* the deploy is safe and was verified:
the target's search-service has no `DATABASE_URL` until the deploy, so it never
reads the new tables, and none of the 15 pending migrations reference the
telemetry tables.

---

## Step 0 — preconditions

- [ ] **Both extensions installed on the target database.** `vector` **and**
      `"uuid-ossp"`. Extensions are per-database, so qa's do nothing for
      production.

      **`"uuid-ossp"` needs the master user too.** It is a *trusted* extension,
      which is easy to misread as "any role can install it" — trusted still
      requires CREATE privilege on the database, and `askwri` does not have it.
      Migration `1781280000000` creates both on line 7 and line 8; skipping
      `uuid-ossp` means the migration run fails on its second statement and
      rolls back. Create both up front, as `postgres`:

      ```
      psql "postgresql://postgres@askwri-db1.cty8g4ssygz9.us-east-2.rds.amazonaws.com:5432/<db>?sslmode=require" -W -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'
      ```

      The RDS master password is **not retrievable** — `MasterUserSecret` is
      null, so there is no Secrets Manager copy and the console will not display
      it. Either ask the instance owner (`wri:owner=kinshuk.govil@wri.org`) or
      reset it: RDS → Databases → `askwri-db1` → Modify → Credentials settings →
      Apply immediately. Resetting does not disrupt the apps, which connect as
      `askwri`, but it is a shared credential on an instance serving both
      environments.

- [ ] **Source is in its validated final state.** Run
      `scripts/verify-corpus-parity.sh <source> <target>` and read the source
      column. `null_embed`, `null_sparse` and `uncached_active` must all be 0.

- [ ] **The source's sparse lane is freshly rebuilt.** Compare
      `keyword_corpus_stats.n_chunks` against `count(*)` from
      `document_chunks`. If they differ, documents were ingested since the last
      `scripts/build_sparse_keyword.py` run and the frozen IDF/avgdl stats have
      drifted — cloning a drifted source copies the drift. On 2026-08-07 the
      stats read 30,396 against 35,449 actual chunks and had to be rebuilt
      first (~85 seconds).

      Rebuild with `SPARSE_EN_HANDLES` set to match what the corpus was built
      under, or the rebuild silently strips every non-English document's English
      handles:

      ```
      SPARSE_EN_HANDLES=true ./scripts/with-remote-env.sh <env> \
        bash -c 'cd search-service && ./venv/bin/python -m scripts.build_sparse_keyword'
      ```

- [ ] **Target's `ingestion_worker_environment_variables` block exists** in its
      tfvars with `SPARSE_EN_HANDLES` matching the corpus. `production.tfvars`
      had no such block at all until PR #318, so the variable fell through to
      its `{}` default.

- [ ] **Target's S3 document bucket holds the same PDFs.** Retrieval does not
      need S3 — it serves from the cloned vectors — so this is not a blocker,
      but "view PDF" links and any re-ingest resolve `documents.s3_key` against
      it. qa and production share `askwri-data`, so this is satisfied by
      construction.

---

## Step 1 — migrations

```
./scripts/with-remote-env.sh <target> npm run typeorm -- migration:show -d src/db/migration-data-source.ts
./scripts/with-remote-env.sh <target> npm run migration:run
```

CI does not run migrations. Confirm the pending list before applying. Two of
them do more than add columns, and both were safe on production precisely
because it had no corpus: `1785916800000` remaps retired "WRI Ross Center"
office values (0 rows), and `1784815300000` conditionally drops the 3-small
index (no-op).

The run is a single transaction per migration, so a failure leaves no partial
state — the 2026-08-07 `uuid-ossp` failure rolled back cleanly to 7 applied
migrations and 6 tables.

---

## Step 2 — clone the corpus

```
./scripts/clone-corpus.sh <source> <target> --dry-run
./scripts/clone-corpus.sh <source> <target>
```

Copies ten tables in FK-dependency order, resets the `keyword_vocab` identity
sequence, and drops/rebuilds the HNSW index around the load. Roughly 5 minutes
end to end for 35k chunks from a laptop, most of it `document_chunks` (~450 MB
with TOAST).

It never references `users`, `audit_log`, `ingestion_jobs`, or the six telemetry
tables. **Never restore a whole-database dump over a deployed environment** —
those telemetry tables are the only irreplaceable data in that database.

Backing up the target's retrieval tables first is worthwhile whenever the target
has a corpus. On 2026-08-07 it was a genuine no-op: production had no corpus
tables at all.

---

## Step 3 — secrets, deploy, restart

Secret changes are **classifier-blocked for the agent** — a human runs the
rebuild. Build every value from the live task definitions rather than typing
them, so nothing is echoed or lands in shell history.

- `SEARCH_SERVICE_ENV` — add `DATABASE_URL` (target's database) and
  `RETRIEVAL_BACKEND=postgres`. **No `EMBEDDING_MODEL` pin**; the v3 code
  defaults to `cohere-embed-v4`.
- `ASKWRI_APP_ENV` — add `SESSION_SECRET`. **Generate a new one.** Reusing qa's
  would make a qa-signed admin cookie valid in production.
- `INGESTION_WORKER_ENV` — `DATABASE_URL`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`,
  `PARSE_BACKEND=mistral`, `BEDROCK_EMBED_MODEL_ID=us.cohere.embed-v4:0`,
  `AWS_RETRY_MODE=adaptive`, `AWS_MAX_ATTEMPTS=10`.

Leave `MISTRAL_OCR_MODEL` and `FORCE_REPARSE` **unset**. The cloned
`document_texts` rows are stamped `mistral` / `mistral-ocr-latest`; pinning a
dated model id or forcing a reparse invalidates every stamp and buys a
full-corpus re-OCR at real cost.

Production's secrets are `production`-environment-scoped — a repo-level
`gh secret set` does not touch them. Set with
`gh secret set <NAME> --repo wri/askwri --env production`.

Then deploy (merge `qa` → `production`; `deploy-production.yml` applies
Terraform, which creates the ingestion-worker task family, then rolls all three
services).

**Then force a new deployment of the search-service and the ingestion worker.**
Neither reloads the corpus on its own — the search service holds whatever it
loaded at boot, and if it booted before the clone it is still in the
green-but-broken state:

```
aws ecs update-service --cluster askwri-app-<env>-cluster \
  --service askwri-app-<env>-search-service --force-new-deployment --region us-east-2
```

Confirm the boot log reads `✅ Postgres-backed retrieval ready (N documents)`
and `📊 Keyword lane: Postgres sparse (N chunks)`.

---

## Step 4 — verify and canary

```
./scripts/verify-corpus-parity.sh <source> <target>
```

Then a real query, not just `/api/health`:

```
curl -s -X POST https://<host>/api/llamaindex -H 'Content-Type: application/json' \
  -d '{"query":"What have we published on hydrogen?","mode":"cite"}'
```

Then one canary ingest through the target's own worker:

```
./scripts/with-remote-env.sh <target> bash -c \
  'cd search-service && ./venv/bin/python -m scripts.reingest_all --ids <one-uuid>'
```

Pick a **non-English** document. An English one never exercises the
English-handles injection, which is the part most recently changed and most
easily misconfigured.

**Know what this canary does and does not prove.** The cloned parse stamps
cache-hit, so the worker logs `parse cache hit, skipping OCR` and never calls
Mistral. That is the desired behaviour — a re-ingest of a cloned corpus must
never re-OCR — but it means the canary does **not** exercise the Mistral key.
Proving that path needs a genuinely new PDF. The 2026-07 plan claimed this
canary tested the Mistral key; it does not.

Expect `vocab_terms` to run slightly ahead on whichever side ingested last: the
embed stage mints previously-unseen tokens at `df=1` against the frozen stats.
One canary document added 25. That is documented steady-state drift, not
corruption, and it clears on the next `build_sparse_keyword.py`.

---

## Rollback

Restore the target's retrieval tables from a pre-clone backup. If the code must
fall back too, re-add the `EMBEDDING_MODEL=text-embedding-3-small` pin and
redeploy. Migrations revert individually, newest first, with
`npm run migration:revert`. The corpus clone and the sparse backfill are each a
single transaction, so a mid-run failure leaves no partial state.

---

## Banked lessons

- **Both extensions, and both need the master user.** "Trusted" is not the same
  as "installable by the app role".
- **A green pipeline is not a working deploy.** ECS reporting a service healthy
  says only that the task started. Check the boot log for the readiness line.
- **Services do not reload after a data change.** Force a new deployment.
- **Org Mistral key, never personal.** qa's as-built used a personal key and
  production inherited it at cutover. That is debt, not a pattern to copy.
- **Any future bulk re-ingest**: one worker, `BEDROCK_EMBED_BATCH_SIZE=24`,
  `AWS_RETRY_MODE=adaptive`, the `us.cohere.embed-v4:0` profile, and re-run
  `build_sparse_keyword.py` afterward before any threshold work.
- **Measurement parity**: replay smoke queries through `/api/llamaindex` with
  matching `fusion_top_k`/`denseTopK`/`sparseTopK`, or the numbers under-report.
- **Counts belong in the database, not in prose.** Every figure this document
  used to hardcode went stale.

---

## Known-open after the 2026-08-07 cutover

- **The `production` GitHub Environment has no protection rules**, and
  `deploy-production.yml` also fires on pushes to `main` — which is a
  three-commit junk branch, not the release branch. Promotion is by PR from
  `qa` to `production`. A required reviewer would remove the whole class of
  accident.
- **Production's app task is `container_memory = 1024`** while qa runs 2048.
  The intake route still buffers whole uploads via `req.formData()`
  (`src/app/api/admin/intake/route.ts:65`) behind a 100 MB cap, and prod runs
  `desired_count = 1`, so one large upload can OOM the single task into a
  site-wide 502. This mattered less when prod only served queries; it is now
  the primary ingestion path.
- **Secrets Manager migration** — the API keys still sit in plaintext
  `environment` entries rather than a `secrets` block with a `valueFrom` ARN.
  Doing it once for both environments would also make key rotation a console
  edit plus a `force-new-deployment`.
- **The production → qa refresh.** Now that production is primary, qa drifts off
  reality as prod accumulates documents. `scripts/clone-corpus.sh` takes the
  direction as an argument for exactly this. Needs its own conversation about
  what happens to qa-only test documents.
