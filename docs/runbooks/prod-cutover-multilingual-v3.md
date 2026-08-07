# Production cutover runbook — mirror qa (multilingual-v3)

**Purpose:** bring production to qa's validated end-state (all-cohere,
all-Mistral, fusion-500, us-east-1 rerank, floor 0.09, maxResults 25,
SecretStr), then leave prod ready to become the **primary ingestion path**.

**Companion:** `docs/runbooks/qa-deploy-multilingual-v3.md` is the lab notebook
— it records *how the decisions were made*. This runbook does not repeat any of
that. It applies the result.

---

## The model (read first)

- **qa is the proving ground; prod mirrors qa's validated state.** All
  investigation — parser bake-off, threshold derivation, gates — happened on qa
  and is done. Prod carries **zero** re-derivation. If a value here looks worth
  re-checking, re-check it on qa, not prod.
- **This is a one-time catch-up, then the relationship inverts.** After cutover,
  new documents flow through **prod**, not qa. So prod must be a **fully
  ingestion-capable** environment, not just a serving mirror — its worker has to
  parse/embed/index exactly like qa's.
- **Method: clone + capability + canary.**
  1. **Capability** — deploy qa's proven code/config to prod so it can serve
     *and* ingest.
  2. **Clone** — copy qa's finished corpus data into prod (a literal mirror,
     minutes, no re-parse).
  3. **Canary** — one ingest to prove the going-forward pipeline before real
     users lean on it.

  Clone (not replay) for the seed because the goal is to *mirror* qa's data, and
  a full dump/restore is a self-consistent literal copy. Capability is deployed
  separately so prod can ingest new docs afterward; the clone itself needs no
  Mistral key and no re-parse.

---

## qa → prod substitutions (the ONLY differences)

| | qa | prod |
|---|---|---|
| Deploy | push to `qa` / `deploy-qa.yml` | push to `main`/`production` / `deploy-production.yml` |
| GitHub secrets | repo-level | **`production` environment-scoped** (`gh secret set --env production`) |
| DB access | `with-remote-env.sh qa` | `with-remote-env.sh production` |
| Mistral key | personal (as-built debt) | **org/team key** (start right) |
| Endpoint | `qa.askwri-app.org` | prod endpoint (confirm) |

Everything else — sequence, settings, gotchas — is identical, because prod
mirrors qa.

---

> **REVISED 2026-08-05 — read this before the steps below.** This runbook was
> written assuming prod had already completed the Phase 0 cutover and was
> serving from Postgres with a `text-embedding-3-small` corpus. **It has not.**
> Verified against prod on 2026-08-05:
>
> | Check | Prod's actual state |
> |---|---|
> | `migrations` applied | **7**, all Feb–Mar 2026 (`1772…`/`1773…`) — qa has 22 |
> | `documents` table | **does not exist** |
> | pgvector extension | **not installed** on the `production` database |
> | Tables present | only 6, all telemetry: `answer_mode_feedback`, `answer_mode_query_logs`, `cite_mode_feedback`, `cite_mode_query_logs`, `user_feedback`, `migrations` |
> | Services | app + search-service only — **no ingestion worker** |
> | Search backend env | no `DATABASE_URL`/`RETRIEVAL_BACKEND`/`KEYWORD_BACKEND`/`EMBEDDING_MODEL`/`PARSE_BACKEND` → still **legacy** (CSV + in-memory) |
>
> Consequences, all of which make the job easier except the first:
>
> - **Phase 1 is bigger than written.** Prod needs `CREATE EXTENSION vector` and
>   **15** migrations to reach qa's 22, not a short catch-up.
> - **Step 0's "prod corpus is disposable" is moot** — there is no prod corpus.
>   Same for the Phase 2 step 4 backup and the step 7 3-small index retirement:
>   both are no-ops. Nothing to reconcile, nothing to merge.
> - **Protect the six telemetry tables.** They hold real production history and
>   are the only thing in that database worth keeping. They are already absent
>   from the clone list below — keep it that way, and never restore a whole-
>   database dump over `production`.
> - **Prod and qa share one RDS instance** (`askwri-db1…`), databases
>   `production` and `qa`. The clone is a local operation on one server.
> - **Prod and qa share one S3 bucket** (`askwri-data`). The PDFs are already in
>   place; the Step 0 bucket check below is satisfied by construction.
>
> Also since this runbook was written (#314/#315, 2026-08-05):
>
> - `document_texts` carries parse-cache stamps, and the clone brings them, so
>   **a prod re-ingest performs zero OCR**. Keep `FORCE_REPARSE` unset on prod or
>   that inheritance is thrown away and you pay for a full re-OCR.
> - Every qa document now has a `content_hash`, so prod inherits working
>   corpus-wide duplicate detection from day one. (Hashing qa's corpus found 4
>   byte-identical duplicate pairs, since withdrawn.)
> - The worker image ships Ghostscript and a page-split fallback, so prod can
>   ingest PDFs over Mistral's 50MB limit. The upload cap is 100MB and
>   `proxyClientMaxBodySize` is 105mb — the proxy buffer is held per in-flight
>   request, so check prod's app task memory before assuming that is free.
> - The counts quoted below (168 docs, 27,878 chunks) are **stale and will stale
>   again**. Derive them from qa at cutover time; do not trust this document.

## Step 0 — preconditions (confirm / provision before touching prod)

- [ ] **Prod corpus is disposable.** No longer applicable — prod has no corpus
      tables at all (see the 2026-08-05 revision note). Confirm this is still
      true rather than assuming it.
- [ ] **pgvector installed on the `production` database** —
      `CREATE EXTENSION IF NOT EXISTS vector;`. It is available on the instance
      (qa uses it) but extensions are per-database.
- [ ] **Prod org Mistral key provisioned** (Mistral console, org/team — never a
      personal key). This is for *going-forward* ingestion, not for the clone.
- [ ] **Confirm prod topology** (read-only): prod `/health` + a
      `SELECT embedding_model, count(*) FROM document_chunks GROUP BY 1` and doc
      count via `with-remote-env.sh production` (records what we overwrite);
      prod's `DOCUMENTS_S3_BUCKET`; prod's document-view endpoint.
- [ ] **Prod's document S3 bucket holds the same PDFs** as the cloned corpus.
      Retrieval does NOT need S3 (it serves from the cloned vectors), so this is
      not a blocker — but "view PDF" links and any future *re-ingest* of a cloned
      doc resolve `documents.s3_key` against this bucket. If it differs, view
      links break until the bucket is synced; search is unaffected.
- [ ] **qa is in its validated final state.** This is the clone source of truth.
      Do NOT copy a count from this document — read it from qa at cutover time:

      ```sql
      SELECT count(*) FILTER (WHERE status <> 'withdrawn') AS active_docs,
             (SELECT count(*) FROM document_chunks) AS chunks,
             (SELECT count(*) FROM document_chunks WHERE embedding IS NULL) AS null_embed,
             (SELECT count(*) FROM document_chunks WHERE sparse IS NULL) AS null_sparse,
             (SELECT count(*) FROM document_texts WHERE parsed_content_hash IS NULL) AS uncached
      FROM documents;
      ```

      `null_embed` and `null_sparse` must be 0. `uncached` should be 0 for active
      documents, or prod inherits an incomplete parse cache.
- [ ] **qa's sparse lane is freshly rebuilt.** After any bulk re-ingest,
      `scripts/build_sparse_keyword.py` must have been re-run — the embed stage
      assigns new tokens `df=1` from FROZEN stats, so a campaign leaves both the
      stats and those tokens drifted. Cloning a drifted qa copies the drift.

---

## Phase 1 — Capability: deploy qa's proven config to prod

1. **Rebuild prod's `production`-scoped secrets** to match qa's proven config.
   Secret changes are **classifier-blocked for the agent** — run the rebuild
   script yourself (same pattern as the Mistral key rotation), values pulled from
   the live prod task def, never printed:
   - `SEARCH_SERVICE_ENV`: **no `EMBEDDING_MODEL` pin** → the v3 code defaults to
     `cohere-embed-v4`.
   - `INGESTION_WORKER_ENV`: add `MISTRAL_API_KEY` (org key) +
     `PARSE_BACKEND=mistral` + `AWS_RETRY_MODE=adaptive` + `AWS_MAX_ATTEMPTS=10` +
     `BEDROCK_EMBED_MODEL_ID=us.cohere.embed-v4:0`.
     (`BEDROCK_EMBED_BATCH_SIZE` only matters for BULK runs; normal per-doc
     intake is fine at the default 96.)
   - **The retrieval knobs are CODE, not secrets** — fusion-500, floor 0.09,
     maxResults 25, us-east-1 rerank, and SecretStr all ship in the v3 images.
     Nothing to set for them; deploying the images is enough.
2. **Deploy prod** via your release mechanism (push to `main`/`production`, or
   `gh workflow run deploy-production.yml`). Terraform apply grants
   `bedrock:InvokeModel` + `bedrock:Rerank` to prod's task role (same shared
   terraform as qa) before the ECS deploy, per `needs: deploy-infrastructure`.
3. **Apply migrations on prod** — `with-remote-env.sh production npm run
   migration:run` (CI does NOT run migrations). This is **15 migrations**, not a
   short catch-up: prod is at 7 (Feb–Mar 2026) and qa is at 22. Run
   `migration:show` first and confirm the pending list before applying.

   `CREATE EXTENSION vector` must already have happened (Step 0) — the Phase 0
   schema migration creates `vector`/`sparsevec` columns and fails without it.

   Two migrations in that run do more than add columns, and both are safe here
   precisely because prod has no corpus:
   - `1785916800000` remaps retired "WRI Ross Center" office values. On prod it
     matches 0 rows.
   - `1784815300000` conditionally drops the 3-small index. On prod it no-ops —
     there is no 3-small corpus. Phase 2 step 7 is therefore also a no-op.

After Phase 1 prod can serve and ingest like qa — it is just still holding its
old corpus.

---

## Phase 2 — Seed: clone qa's corpus into prod

4. **Back up prod's current retrieval tables first** (two-way door; cheap even
   though disposable) — e.g. `..._prod_precutover_backup_<date>`.
5. **Data-only clone qa → prod** of the corpus/retrieval tables:
   - **Clone:** `documents`, `document_texts`, `document_chunks`,
     `document_summaries`, `keyword_vocab`, `keyword_corpus_stats`, `tags`,
     `document_tags`, `collections`, `document_collections`.
   - **Do NOT clone:** `users`, `audit_log` (prod keeps its own auth + history),
     `ingestion_jobs` (transient — prod starts fresh), and the six telemetry
     tables (`answer_mode_feedback`, `answer_mode_query_logs`,
     `cite_mode_feedback`, `cite_mode_query_logs`, `user_feedback`,
     `migrations`) — those are prod's real production history and the only data
     in that database worth protecting. Clone by explicit table list; never
     restore a whole-database dump over `production`.
   - Mechanics: `pg_dump --data-only` the tables from qa → truncate prod's
     targets → load in FK-dependency order (or `--disable-triggers`). At ~28k
     chunks the cohere HNSW index builds on load; drop-load-recreate the index if
     you want it faster.
6. **Verify prod now equals qa:** re-run Step 0's count query against BOTH
   databases and diff the results — the numbers must match each other, not the
   stale figures once quoted here (168 docs / 27,878 chunks, correct as of
   2026-07-23 and wrong since). Also confirm 100% cohere, 0 null
   embedding/sparse, and a matching language distribution.

   Add one check this runbook predates: `document_texts.parsed_content_hash`
   should be non-NULL for every active document on prod. That is the inherited
   parse cache — if it is NULL, prod will re-OCR the entire corpus on its first
   re-ingest.
   - **No sparse rebuild needed.** `keyword_vocab`, `keyword_corpus_stats`, and
     `document_chunks.sparse` all came from qa together, so the sparse lane is
     internally consistent. (This is the clone's advantage over a replay — a
     replay *would* require `build_sparse_keyword.py`.)
7. **Retire the now-empty 3-small index** — re-run migration `1784815300000`
   (it drops now, since prod holds 0 `text-embedding-3-small` rows) or drop it
   directly.

---

## Phase 3 — Verify (sanity, NOT derivation)

8. **Smoke check** through `/api/llamaindex` with eval-matching params
   (measurement parity — the stock `/query` path is not what users hit):
   `/health` healthy + dense live + 168 docs; a cite query returns
   `relevance_tier`s; non-English smoke 16/16 present. Pass = mirror confirmed.
   Gross failure = rollback (step 4).
9. **Canary ingest — prove the GOING-FORWARD pipeline** before real users:
   ingest ONE doc through prod's worker (a fresh drop, or
   `reingest_all --ids <one id>`). This exercises prod's **org Mistral key** +
   Bedrock embed (task role) + sparse write against the cloned vocab — the parts
   the clone did not test. Verify: job `done`, Mistral markdown, 0 `/gid`,
   cohere, sparse present, `searchable`. This is the real proof prod is ready to
   be primary. (qa already proved the pipeline at 160-doc scale, so one doc here
   is sufficient.)

---

## Rollback

Restore prod's retrieval tables from the step-4 backup. If the code needs to fall
back too, re-add the `EMBEDDING_MODEL=text-embedding-3-small` pin and redeploy.
Low-stakes: prod's pre-cutover corpus was disposable.

---

## Banked qa lessons (carried, not re-learned)

- **Org Mistral key, never personal** (qa's as-built used a personal key — that
  is debt, not a pattern to copy).
- **Any FUTURE bulk re-ingest on prod**: one worker + `BEDROCK_EMBED_BATCH_SIZE=24`
  + `AWS_RETRY_MODE=adaptive` + the `us.cohere.embed-v4:0` profile, and run
  `build_sparse_keyword.py` afterward before any threshold work. (The clone in
  this runbook needs none of that — it is pure data transfer.)
- **Back up before any in-place mutation.**
- **Secret changes are run by a human** (classifier-blocked for the agent),
  rebuilt from the live task def so values never print. Prod's secrets are
  `production`-environment-scoped — a repo-level `gh secret set` would not touch
  them.
- **Measurement parity**: replay smoke queries through `/api/llamaindex` with
  matching `fusion_top_k`/`denseTopK`/`sparseTopK`, or numbers under-report.
- **The `.env.local` fake-MinIO-key footgun is LOCAL-only** — deployed prod uses
  the task role and is immune. Not a prod concern.

---

## Out of scope (separate work, flagged not bundled)

- **Secrets Manager migration** — move the API keys from plaintext `environment`
  entries to a `secrets` block (`valueFrom` an ARN). Removes the plaintext
  exposure in the task defs AND enables rotating a key by editing the value in
  the console + a plain `force-new-deployment`, no full redeploy. Do this once,
  for both environments; it is not part of mirroring qa.
- **The future prod→qa refresh.** Once prod is primary and accumulates documents
  qa lacks, the lab drifts off reality — keeping qa representative eventually
  means periodically cloning **prod→qa** (the clone direction inverts). Its own
  design conversation when prod has meaningful unique data.
