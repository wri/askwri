# AskWRI Document Management — As-Built Reference

**Audience:** engineers working on Phase 1 or later.
**Phases covered:** 0 — Store + Migration (shipped); 1 — Ingestion + Classification (shipped); 2 — Admin UI + review queue (shipped, §11); plus the sparse keyword lane (shipped 2026-06-11, `KEYWORD_BACKEND=sparse` default).
**Runbook:** [docs/runbooks/phase0-cutover.md](runbooks/phase0-cutover.md)
**Design doc:** [docs/plans/2026-06-09-askwri-document-management-design.md](plans/2026-06-09-askwri-document-management-design.md)

---

## 1. What Phase 0 is

Phase 0 moves document metadata, chunks, and embeddings from a flat CSV + boot-time in-memory rebuild into RDS Postgres (pgvector). The search-service gains a `RETRIEVAL_BACKEND=postgres` mode that reads from Postgres instead of rebuilding at boot. The `/query` contract is unchanged. No user-visible change.

---

## 2. Deltas from the design doc

The design doc (`docs/plans/2026-06-09-askwri-document-management-design.md`, §6) is the intended end-state schema. Phase 0 shipped the following differences:

### ADDED — not in the design

| Addition | Rationale |
|---|---|
| `documents.source_metadata` jsonb | Stores the original CSV row verbatim (`{file_path, summary, metadata: {…raw keys…}}`). Lets the catalog API and future migrations access the original data without re-parsing CSV. |
| `documents.authors`, `documents.url`, `documents.date_published` | Editable structured columns backfilled from `source_metadata.metadata` (CSV keys `All authors`, `URL`, `Date published`). Promoted from jsonb-only to first-class columns per the Phase 0 lean-core pattern (design §20: fixed columns for now; `document_attributes` deferred). |
| `documents.content_hash` unique partial index | DB-level dedup enforcement (no two docs with the same content hash). |
| `GET /api/admin/worker-health` | Worker liveness (`idle`/`processing`/`stale`), queue depth, intake backlog — catches the case where uploaded files sit in `intake/` unprocessed because the worker is down. |
| `GET /api/admin/corpus-health` | Corpus health dashboard: counts by status/language, review-queue depth, missing-renditions (non-EN docs without native summaries), missing `title_en`, low-confidence docs. Surfaces the multilingual gaps the design §11.317 dashboard was meant to catch. |
| `PATCH /api/admin/documents/[id]/summaries` | Edit a single summary (language, kind, text); `source='human'` rows are protected. |
| `documents.abstract` column **dropped** | Dead column (0/170 populated, no reader/writer anywhere). The live summary store is `document_summaries`; `abstract` was intended for GROBID extraction (dropped, §9). Removed in migration `1781320000000`. |
| `document_chunks.corpus_order` integer (migration `1781290000000`) | BM25 breaks score ties by corpus position. The chunk load order from Postgres must reproduce the legacy node build order exactly. Populated by the migration script from `enumerate(nodes)`. **Reordering the migration script WILL silently change retrieval tail rankings.** |

### DEFERRED — in the design, not in Phase 0

Per design §20 lean-core cut:

- `works`/versioning/translation grouping — removed under "one paper = one original document" assumption.
- `document_attributes` (typed attributes table) — deferred; categorical tags + fixed columns for now.
- Tag-label localization (`tag_labels` table) — canonical English `value_id` only.
- Authoritative-import precedence subtleties (dry-run diff, `source=external` overwrite protection) — tags seeded with `source='external'`, `status='accepted'`; overwrite precedence logic deferred to Phase 1.
- `sparsevec` / BGE-M3 sparse lane — column exists in schema (`document_chunks.sparse`), not populated at Phase 0. (Phase 1 did NOT replace the in-memory BM25 as predicted here; the keyword-lane workstream did on 2026-06-11 — `document_chunks.sparse` now holds BM25 impact vectors and `KEYWORD_BACKEND=sparse` is the default. BGE-M3 weights remain a future option on the same column.)
- GROBID / layout-parser ingestion pipeline — Phase 1.
- Admin UI, collections UI, auth — Phase 2.
- Dense-model bake-off, CJK ingestion, versioning/lifecycle — Phase 3.

---

## 3. Schema — the 11 tables

Migration history (all TypeORM raw-SQL under `src/db/migrations/`): `1781280000000` (initial 11 tables), `1781290000000` (`corpus_order` column + index), `1781300000000` (open-job unique index + FK cascade), `1781310000000` (keyword-lane tables), `1781320000000` (authors/url/date_published columns, title/summary data fixes, content-hash dedup index, drops dead `abstract`), `1781330000000` (`metadata_source` provenance), `1781340000000` (`metadata_source` key normalization).

### Write ownership rule

- **App tier (TypeORM):** owns ALL DDL and admin-driven CRUD on the relational tables (`documents`, `document_summaries`, `tags`, `document_tags`, `collections`, `document_collections`, `ingestion_jobs`, `users`, `audit_log`). One TypeORM entity exists for `documents` (`src/db/entities/Document.entity.ts`); `IngestionJob` entity added in Phase 1 and registered in both data sources.
- **Python side (search-service / ingestion worker):** writes `document_chunks` rows and `document_texts` rows (raw psycopg SQL). Reads everything else. Never issues DDL.
- **Ingestion worker (Scope decision #4 — Phase 1 amendment):** the ingestion domain is worker-owned. For documents it ingests, the worker may INSERT `documents` rows (status `draft`) and write `document_texts`, `document_summaries`, `document_chunks`, LLM `document_tags`, `ingestion_jobs`, and `audit_log` rows. The CSV import API (`POST /api/import-documents`) creates `documents` rows app-side (with queued jobs); the worker then drives those jobs through the pipeline. Human/external `document_tags` rows (`source='human'` or `source='external'`) are never modified by the worker.

### Table reference

| Table | Purpose | Key columns | Written by |
|---|---|---|---|
| `documents` | One row per document. System of record. | `id` (uuid PK), `external_id` (unique, legacy doc_id), `s3_key`, `title`, `language`, `languages[]`, `status`, `source_metadata` (jsonb) | App tier |
| `document_texts` | Full extracted text per document (for query-time passage context). | `document_id` (PK, FK → documents), `full_text`, `page_boundaries` (jsonb), `char_count` | Python migration script |
| `document_summaries` | Per-language summaries (long/short). | `(document_id, language, kind)` composite PK, `text`, `source` | Python migration script |
| `document_chunks` | Retrieval units (text chunks + embeddings). One row per chunk or summary node. | `id` (uuid PK), `document_id` (FK), `legacy_chunk_id` (unique, e.g. `2021_doc_chunk_0`), `chunk_index`, `unit_type` (`text`\|`summary`), `text`, `node_metadata` (jsonb, full legacy metadata verbatim), `embedding` (vector), `embedding_model`, `dimension`, `sparse` (sparsevec — BM25 impact vectors, the live keyword lane; populated by `scripts/build_sparse_keyword.py` backfill and the worker embed stage), `corpus_order` | Python migration script |
| `tags` | Controlled vocabulary. Taxonomy v1. | `id` (uuid PK), `facet`, `value_id`, `taxonomy_version` | App tier / migration script |
| `document_tags` | Many-to-many docs↔tags with provenance. | `(document_id, tag_id)` composite PK, `source`, `confidence`, `status` | App tier / migration script |
| `collections` | Curatorial containers. | `id`, `name`, `slug` (unique), `language_policy` (jsonb), `embedding_model_version` | App tier / migration script |
| `document_collections` | Many-to-many docs↔collections. | `(document_id, collection_id)` composite PK, `added_by`, `added_at` | App tier / migration script |
| `ingestion_jobs` | Durable ingestion job queue (Phase 1 worker). | `id`, `document_id`, `stage`, `status`, `error`, `attempts`, `model_versions` | App tier |
| `users` | Admin users (Phase 2 admin UI). | `id`, `username` (unique), `password_hash`, `role` (`admin`\|`editor`), `active` | App tier |
| `audit_log` | Append-only mutation log. | `id` (bigserial PK), `actor_user_id`, `source`, `action`, `entity_type`, `entity_id`, `before`/`after` jsonb | App tier / migration script |

Notable DDL details:
- `CREATE EXTENSION IF NOT EXISTS vector` and `uuid-ossp` in the first migration.
- HNSW index on `document_chunks.embedding` (partial, `WHERE embedding_model = 'text-embedding-3-small'`; `ef_search` set to 1000 at query time for near-exact recall at this corpus size).
- Index on `document_chunks.corpus_order` for efficient ordered boot load.
- No entity maps `document_chunks` or `document_texts` — vector columns are not TypeORM-native; DDL lives in the migration only.

---

## 4. Document lifecycle

Statuses: `draft → searchable → withdrawn` (plus `processing`, `needs_review`, `error` for the Phase 1 ingestion worker).

Phase 0 migration sets all migrated documents directly to `searchable` (bypassing the ingestion pipeline).

### Retrieval filtering — operational gotcha

All retrieval queries in `pg_store.py` filter `WHERE d.status = 'searchable'`. This means:

- **Dense lane (pgvector):** withdrawing a document (`UPDATE documents SET status='withdrawn'`) removes it from the next query immediately — the SQL filter excludes it per-query.
- **Keyword lane (`KEYWORD_BACKEND=sparse`, default since 2026-06-11):** BM25 impact vectors are stored in `document_chunks.sparse` and filtered per-query with `WHERE status='searchable'`. Withdraw and promote operations take effect on the next query with no operational step required.

**Operational implication (default sparse backend):** no manual action needed after lifecycle changes — both lanes filter per-query.

**Legacy memory backend note:** with `KEYWORD_BACKEND=memory`, the old staleness behavior returns. The BM25 index is hydrated at boot or `/reindex`; after a withdrawal, the in-memory index still holds those chunks until `/reindex` is called or the service restarts. A manual `POST /reindex` is required after any lifecycle change.

**Frozen stats refresh:** under the sparse backend, new documents are weighted at embed time using IDF/avgdl statistics frozen by the last `build_sparse_keyword.py` run (tokens unseen at freeze time enter the vocab with `df=1`, i.e. maximal IDF, until the next refresh). Re-run that script after bulk corpus changes to refresh keyword statistics. The script covers **all** document statuses (not just searchable), is idempotent and transactional, and **the ingestion worker must be idle while it runs** (a concurrent embed stage races the vocab/stats writes). This is never required for lifecycle correctness (promote/withdraw) — only for accurate weighting of newly ingested documents.

**Pre-backfill edge case:** a document ingested before `build_sparse_keyword.py` has ever run (e.g. during an initial cutover window) gets `sparse = NULL` chunks — absent from keyword-lane results (dense lane unaffected) until the next backfill run. The sparse-mode boot guard refuses to start against a fully unpopulated corpus, so this only arises for documents added mid-cutover.

---

## 5. Retrieval backends

Switched by `RETRIEVAL_BACKEND` env var in `search-service/app/config.py`.

| Backend | Value | Boot behavior | Dense lane | BM25 lane |
|---|---|---|---|---|
| Legacy | `legacy` (default) | Parses CSV + PDFs, builds in-memory indexes (cached; ~30 min cold) | LlamaIndex `VectorStoreIndex` in-memory | `BM25Retriever` over in-memory nodes |
| Postgres | `postgres` | Reads `document_chunks` from Postgres (seconds; no OpenAI calls) | `PgVectorRetriever` (SQL per query, pgvector HNSW) | See keyword lane below |

Both backends serve the same frozen `/query` contract (`QueryRequest`/`QueryResponse` in `search-service/app/main.py`). The `/reindex` endpoint re-runs the active boot path (re-reads Postgres in postgres mode; re-parses CSV in legacy mode).

`CATALOG_SOURCE=postgres` (app tier) switches `/api/catalog` from reading the CSV to reading `documents.source_metadata` from Postgres.

**Keyword lane** (`RETRIEVAL_BACKEND=postgres` only) — controlled by `KEYWORD_BACKEND`:

| Value | Boot behavior | Query behavior |
|---|---|---|
| `sparse` (default) | No BM25 build; sparse vectors already in `document_chunks.sparse` | Per-query SQL with `WHERE status='searchable'` filter; requires `build_sparse_keyword.py` to have run |
| `memory` | Hydrates `BM25Retriever` from Postgres chunk rows at boot or `/reindex` | In-memory lookup; stale until next boot or `/reindex` |

Under `KEYWORD_BACKEND=sparse`, the `/reindex` endpoint no longer rebuilds the BM25 index. It refreshes in-memory passage-context texts and metadata (build-then-swap, ~11 s) used for answer synthesis — the worker publish stage still calls it for that reason (retrying once on `409 already_running`).

`GET /health` reports the active backends — `keyword_backend` and `retrieval_backend` fields — alongside the index-readiness flags; the eval runners read these to stamp their reports.

---

## 6. Tagging — taxonomy v1

Seeded by `search-service/scripts/migrate_csv_to_postgres.py` from the legacy CSV fields. No LLM classification in Phase 0.

| Facet | Source CSV key |
|---|---|
| `program` | `wri_programs` |
| `office` | `wri_primary_office` |
| `topic` | `Sub-tag` |
| `doc_type` | `article_type` |

All seeded tags have `source='external'`, `status='accepted'`, `confidence=1.0`, `taxonomy_version='v1'`. Tag values are the raw CSV strings (not normalized). Deduplication is by `(facet, value_id, taxonomy_version)` unique constraint; one tag row per unique value, shared across documents.

Phase 1 will add LLM-based classification and may normalize/re-seed tag values.

---

## 7. Known data caveats

### Language coverage

The corpus contains 169 documents. Language distribution from the migration (as mapped by `LANGUAGE_MAP` in the migration script):

| Language | Code | Count |
|---|---|---|
| English | `en` | 136 |
| Chinese | `zh` | 19 |
| Spanish | `es` | 10 |
| Portuguese | `pt` | 4 |

**2 documents are labeled "Bahasa" in the CSV.** "Bahasa" (Indonesian) is not in the design's target language set (EN/ES/ZH/PT) and is not in `LANGUAGE_MAP`. The migration script logs a warning (`! unmapped language labels ['bahasa']`) and defaults these documents to `language='en'`. They are indexed as English. Phase 1 should address Indonesian explicitly or gate on language detection.

### Summary coverage

As migrated, all 169 documents have both `long` and `short` rows in `document_summaries` and a summary chunk in `document_chunks` (`unit_type='summary'`, `chunk_index=-1`) — verified 169/169 at migration time. Note for future imports: a document with an empty `summary` field gets no `long` summary row and no summary chunk (the migration script and node builder both skip it).

---

## 8. Retrieval parity status

Full results are recorded in `docs/plans/2026-06-09-phase0-store-and-migration-plan.md` (Task 10, "Parity results" subsection).

**Summary (2026-06-10):** PASS with caveats. Cite-mode precision/F1 essentially equal; cite recall +1.5 points. Answer doc-level F1 improved (+2.1). Answer chunk-adjacent F1 −2.4 points (just past the ±2 design gate). Top-20 overlap 0.940 (threshold 0.95, exit 1 on the comparison script). Two rank-1 near-ties swapped (q7, q10 — same two docs, positions 1↔2).

Root cause: residual divergence is confined to marginal documents at the reranker logit floor and near-tie positions. Dense and BM25 lanes are individually deterministic and sequence-identical when `corpus_order` is respected. Both backends are PASS on the core design gate (§14.5): overall metrics equal-or-better, no systematic retrieval regression.

Flagged for the retrieval workstream: chunk-adjacent F1 −2.4, q2 single-doc recall dip, top-20 overlap sensitivity at margins.

Eval provenance note: eval reports are now identity-stamped (run label + the service's `keyword_backend`/`retrieval_backend` read from `/health`), and per-query checkpoints carry an identity (golden-set hash + service backend + label) — resuming a checkpoint under a different identity is rejected rather than silently mixing runs. Baselines drift with the corpus — compare against a fresh same-day baseline, not historical numbers.

---

## 9. Phase 1 prediction corrections

The original Phase 1 prediction in this section was partially wrong. Actual outcomes:

- **Sparse lane (`document_chunks.sparse`):** NOT populated in Phase 1. The sparse/BGE-M3 swap is a separate eval-gated track, deferred pending bake-off results. BM25 remains in-memory.
  **Superseded 2026-06-11:** the keyword-lane workstream replaced the in-memory BM25 with Postgres-resident BM25 impact vectors in `document_chunks.sparse` (`KEYWORD_BACKEND=sparse` default; eval gate PASS). See §5 and the design note `docs/plans/2026-06-11-keyword-lane-replacement-design-note.md`. The BGE-M3 question stays open — it would reuse the same column.
- **GROBID / layout parser:** NOT adopted. PDFReader (LlamaIndex) is retained as the single parser. GROBID is deferred to a future phase.
- **What did ship:** the queue-driven ingestion worker (`ingestion_jobs` activated), LLM auto-tagging (`source='llm'`), generated `document_summaries` for all languages including Indonesian, and the `RETRIEVAL_BACKEND=postgres` dense lane for new chunks. See §10 below.

---

## 10. Phase 1 — Ingestion + classification (as built)

### 10.1 Overview

Phase 1 ships a persistent ingestion worker (`search-service/worker/`) that drives every new document through a six-stage pipeline: parse → language → summarize → classify → embed → publish. Two intake paths feed it: S3/local file drop and a CSV import API.

### 10.2 Intake paths

**Intake A — S3/local file drop**

The worker watches `INTAKE_S3_PREFIX` (default `intake/`) on `DOCUMENTS_S3_BUCKET`. For each PDF found:

1. Compute SHA-256 content hash.
2. If a document with that hash already exists: write an `audit_log` row (`action='duplicate_skipped'`) and remove the object from the intake prefix. No new job is created.
3. Otherwise: insert a `documents` row (`status='draft'`, `external_id=filename minus .pdf`, `content_hash` stored), create a queued `ingestion_jobs` row, write an `audit_log` row (`action='registered'`), and move the object to the `documents/` prefix.

Re-ingest semantics: dropping a file whose `external_id` already exists (different content hash) re-enqueues the existing document row; chunks are replaced atomically by the embed stage; `content_hash` is updated.

Local-dev mode: set `INTAKE_LOCAL_DIR` (e.g. `./intake`). Files are moved to a sibling `documents/` directory instead of S3.

**Intake B — CSV import API**

`POST /api/import-documents` body `{rows: [{file_path, metadata, summary}], dryRun?}`.

Seed semantics: insert new `documents` rows (status `draft`) or fill ONLY currently-NULL columns on existing docs (never clobbers existing values). Column mapping mirrors the Phase 0 migration script (`LANGUAGE_MAP` extended with `bahasa→id`). Creates queued `ingestion_jobs` rows (skipped if an open job already exists for that document). Writes one `audit_log` row per call. `dryRun: true` returns per-row decisions without writing.

### 10.3 Job model and retry semantics

`ingestion_jobs` columns: `id`, `document_id`, `stage` (last completed stage), `status`, `error`, `attempts`, `model_versions`.

Status machine:

```
queued → running → queued (next stage) → … → done | needs_review | error
```

- The worker polls with `SELECT … FOR UPDATE SKIP LOCKED ORDER BY created_at` (oldest first).
- On stage success: `stage` is updated to the completed stage, `status` reset to `queued` for the next stage (or `done` after publish).
- On stage failure: same stage is requeued with `attempts+1`. After `WORKER_MAX_ATTEMPTS` (default 3) failures the job moves to `status='error'`.
- `--once` flag: runs one intake sweep and one job-stage step, then exits. Useful for local iteration and smoke tests (run repeatedly until the job reaches `done`).
- Stale-job reaper: each poll cycle requeues `running` jobs idle longer than `worker_reap_minutes` (default 15) — recovers jobs orphaned by a worker crash or deploy-time task replacement.

### 10.4 Stage pipeline

| Stage | What it does |
|---|---|
| **parse** | PDFReader (LlamaIndex) → `document_texts` (`full_text`, `page_boundaries`). Sets document `status='processing'`. Falls back to title+summary text for CSV-imported docs with no associated file. If no text can be extracted at all, advances to `needs_review`. |
| **language** | langdetect; supported set: `{en, es, zh, pt, id}` (Indonesian added in Phase 1). Unsupported languages fall back to `en`. |
| **summarize** | Generates native-language + English long/short summaries via `WORKER_LLM_MODEL` (default `gpt-5-mini`), `source='generated'`. Skips rows that already exist (including CSV-seeded `source='external'` rows). Also sets `title_en`: for English docs `= title`; for non-English docs an LLM translation of the title. Provenance-guarded via `metadata_source->>'title_en'` (overwrite only when NULL/`llm`; never `human`/`external`) and refreshed from the current title on re-ingest, so `title`/`title_en` never drift. |
| **classify** | LLM call constrained to the `tags` taxonomy v1 values. Writes `document_tags` with `source='llm'`; `status='accepted'` if `confidence ≥ TAG_CONFIDENCE_ACCEPT` (default 0.7), else `status='suggested'`. Never touches rows with `source='human'` or `source='external'`. |
| **embed** | Phase 0-identical chunking *parameters* (SimpleNodeParser 400/80 + summary node, legacy chunk id format, `text-embedding-3-small`). Note: chunk *metadata* diverges from the Phase-0 migration in title source (worker uses `Publication Title` fallback, matching `indexing.build_nodes`; the migration used `Article Title`), authors (worker stores full, not truncated to 100), and `file_path` (worker stores the CSV `file_path`, not `s3_key`). `corpus_order` appended after the current global max (advisory lock for concurrency). Re-ingest deletes prior chunks first. Chinese text and summaries are OpenCC t2s-normalized in chunks only (`document_texts` retains original); page boundaries are recomputed on the Simplified text to avoid OpenCC length-change drift. Also writes sparse keyword vectors under the frozen corpus stats (new tokens get `df=1`); a token_id headroom guard **warns at 80% of `SPARSE_DIM`** and raises a clear error at the cap (run `build_sparse_keyword.py` or migrate the dimension). If `keyword_corpus_stats` is missing (backfill never ran), it writes `NULL` sparse with a warning. |
| **publish** | Computes `extraction_confidence = 0.4·density + 0.3·(language supported) + 0.3·(chunks>0)` where density = `min(chars_per_page / QUALITY_MIN_CHARS_PER_PAGE, 1)` (`QUALITY_MIN_CHARS_PER_PAGE` default 200). If `< 0.7`: document status → `needs_review`. Otherwise: document status → `searchable` + best-effort `POST SEARCH_SERVICE_URL/reindex` (one retry on `409 already_running`) to refresh the service's in-memory passage-context texts/metadata (both retrieval lanes pick up new chunks immediately via SQL under the default sparse backend). |

### 10.5 Document lifecycle update

```
draft → processing (set by parse) → searchable | needs_review
                                                      ↑
                                  error (job exhausted retries)
```

Phase 0 migration set all existing documents directly to `searchable` (bypassing the pipeline). Phase 1 worker advances newly ingested documents through `processing` → `searchable` or `needs_review`.

`needs_review` documents are excluded from retrieval (`status='searchable'` filter in all retrieval SQL). To review and promote:

```sql
-- List documents needing review (with job error if any):
SELECT d.id, d.external_id, d.title, j.error, j.attempts
FROM documents d
JOIN ingestion_jobs j ON j.document_id = d.id
WHERE d.status = 'needs_review'
ORDER BY d.created_at;

-- Promote after manual review:
UPDATE documents SET status = 'searchable' WHERE id = '<uuid>';
```

A review UI shipped in Phase 2; see §11 below.

### 10.6 Worker env vars

| Var | Default | Purpose |
|---|---|---|
| `WORKER_LLM_MODEL` | `gpt-5-mini` | LLM used for summarize and classify stages |
| `WORKER_POLL_SECONDS` | `10` | Seconds between intake sweeps when running in continuous mode |
| `WORKER_MAX_ATTEMPTS` | `3` | Max stage attempts before job status → `error` |
| `WORKER_REAP_MINUTES` | `15` | Stale-job reaper threshold: `running` jobs idle longer than this are requeued |
| `INTAKE_S3_PREFIX` | `intake/` | S3 prefix the worker watches for new PDFs |
| `INTAKE_LOCAL_DIR` | — | Local directory for intake in dev mode (e.g. `./intake`) |
| `DOCUMENTS_S3_BUCKET` | — | S3 bucket for both intake and document storage |
| `DOCUMENTS_S3_PREFIX` | — | S3 prefix for stored documents |
| `TAG_CONFIDENCE_ACCEPT` | `0.7` | LLM tag confidence threshold for `accepted` vs `suggested` |
| `QUALITY_MIN_CHARS_PER_PAGE` | `200` | Chars/page baseline for extraction_confidence density term |
| `SEARCH_SERVICE_URL` | — | Used by publish stage to trigger `/reindex` |
| `OPENAI_API_KEY` | — | Required for summarize and embed stages |
| `DATABASE_URL` | — | Postgres connection string |

### 10.7 Taxonomy human-gate note

Taxonomy v1 is the raw 18 CSV values seeded in Phase 0. A domain owner should curate facets and values before auto-tags are fully trusted in production. Until that curation happens, the `TAG_CONFIDENCE_ACCEPT=0.7` threshold governs which LLM tags are `accepted` vs `suggested`. `suggested` tags are stored but excluded from the default retrieval tag filter.

### 10.8 Deploy

The ingestion worker runs as a separate ECS service (`ingestion-worker`) using the same container image as the search-service, with command override `python -m worker.main`. It has no ALB or service-discovery endpoint; `desired_count=1`. The deploy workflows force-new-deployment for the worker alongside the other services.

CI (`pr-check.yml`) runs a `python-tests` job with a `pgvector/pgvector:pg16` service container and `REQUIRE_DB_TESTS=1` — the DB-dependent worker tests run for real against scratch databases (self-skipping is local-only behavior; in CI a missing DB fails loudly). See the runbook's [What CI runs](runbooks/phase0-cutover.md#what-ci-runs) for the exact module selection.

---

## 11. Phase 2 — Admin UI + review queue (as built)

### 11.1 Auth model

Authentication uses username/password against the existing `users` table. Passwords are stored as bcryptjs hashes (cost 12). On successful login a jose HS256 JWT is issued in an httpOnly `askwri_session` cookie (7-day TTL, `sameSite: lax`, `secure` in production). `SESSION_SECRET` must be at least 32 characters (set via the app-tier secret JSON — see runbook §"Admin UI — local dev").

An optional `ADMIN_API_TOKEN` bearer token acts as an admin identity for machine-to-machine calls (`source='system'`, `actor=NULL` in audit rows). This is the same token used by the ingestion worker for upload intake.

**Caveat:** The edge layer (`src/proxy.ts`) validates the JWT signature only (no DB call). However, every admin API handler underneath calls `requireIdentity`→`getIdentity`, which **re-fetches the user from the DB on every request** and rejects `active===false` immediately, re-deriving `role` from the DB. So deactivation takes effect on the **next API call** (near-immediate), not after the 7-day TTL. The 7-day TTL is only the hard ceiling if the user is never deactivated. A stolen cookie is revoked by deactivating the user.

### 11.2 Route protection

`src/proxy.ts` (Next.js 16 middleware) matches `/admin/:path*` and `/api/admin/:path*` and `/api/import-documents`. Page routes redirect unauthenticated requests to `/admin/login`; API routes return `401` JSON. Role checks (`admin` vs. `editor`) live in individual route handlers via `requireIdentity(req, 'admin'?)`.

### 11.3 Roles

| Role | Capabilities |
|---|---|
| `editor` | Review-queue promote, metadata edits, tag decisions (accept/reject/add human tags), collections CRUD and membership, taxonomy add, upload |
| `admin` | All editor capabilities plus withdraw, taxonomy value deletion, user management |

### 11.4 Page map

All pages are under `/admin`:

| Path | Purpose |
|---|---|
| `/admin/login` | Login form |
| `/admin/review` | Review queue: promote or re-ingest flagged documents |
| `/admin/documents` | Catalog with status/language/collection/search filters and bulk add-to-collection |
| `/admin/documents/[id]` | Document detail: metadata whitelist form, tags grouped by facet (accept/reject on suggested, add human tag), read-only summaries, lifecycle panel (promote/withdraw/re-ingest/Open PDF), collections panel |
| `/admin/collections` | List, create, rename collections |
| `/admin/tags` | Taxonomy list with counts; add value; delete unused (admin only) |
| `/admin/users` | User management (admin only) |
| `/admin/upload` | Multipart PDF intake → S3 `INTAKE_S3_PREFIX` or `INTAKE_LOCAL_DIR`; worker registers and deduplicates |

### 11.5 API map

All APIs are under `/api/admin`:

| Route | Notes |
|---|---|
| `POST /api/admin/auth/login` | Issues session cookie |
| `POST /api/admin/auth/logout` | Clears session cookie |
| `GET /api/admin/auth/me` | Returns current identity |
| `GET /api/admin/review-queue` | Documents at `needs_review` with job details |
| `GET /api/admin/documents` | Catalog list with filters (status/language/collection/tag/search); bulk add-to-collection via `POST /api/admin/collections/[id]/documents` |
| `GET/PATCH /api/admin/documents/[id]` | Fetch or update document metadata (whitelisted fields: title, titleEn, doi, authors, url, datePublished, language, yearPublished, publicationTitle, articleType, wriPrimaryOffice) |
| `POST /api/admin/documents/[id]/status` | Promote (`needs_review → searchable` only) or withdraw (`searchable → withdrawn`, admin-only) |
| `POST /api/admin/documents/[id]/reingest` | Re-queue for ingestion |
| `POST /api/admin/documents/[id]/tags` | Add a tag to a document |
| `PATCH /api/admin/documents/[id]/tags/[tagId]` | Accept or reject a suggested tag (flips `source` to `human`) |
| `DELETE /api/admin/documents/[id]/tags/[tagId]` | Remove a tag from a document |
| `PATCH /api/admin/documents/[id]/summaries` | Edit a single summary (language, kind, text); `source='human'` rows are protected |
| `GET /api/admin/documents/[id]/file` | Streams the PDF from S3 (via sanitized `s3_key`; withdrawn docs excluded) |
| `GET /api/admin/worker-health` | Worker liveness (`idle`/`processing`/`stale`), queue depth, intake backlog |
| `GET /api/admin/corpus-health` | Corpus health: counts by status/language, review-queue depth, missing renditions, missing `title_en`, low-confidence docs, worker status |
| `GET/POST /api/admin/tags` | List taxonomy values; add a new value |
| `DELETE /api/admin/tags/[id]` | Delete unused tag (admin only) |
| `PATCH /api/admin/tags/[id]` | Rename a tag value or facet (admin only) |
| `GET/POST /api/admin/collections` | List or create collections |
| `PATCH /api/admin/collections/[id]` | Rename a collection (regenerates slug) |
| `POST/DELETE /api/admin/collections/[id]/documents` | Add or remove documents from a collection |
| `GET/POST /api/admin/users` | List or create users (admin only) |
| `PATCH /api/admin/users/[id]` | Update user (admin only; self-demote blocked; last-admin guard) |
| `POST /api/admin/intake` | Upload a PDF to the S3 intake queue |
| `POST /api/import-documents` | CSV bulk import (admin-only; creates `documents` rows + `ingestion_jobs`; `s3_key` validated) |

All mutating endpoints write `audit_log` rows (actor, `source: human|system`, action, entity type, before/after JSON snapshot).

### 11.6 Tag-decision provenance (Scope decision 7)

When an editor accepts or rejects a suggested LLM tag, the `document_tags` row has its `status` set to `accepted` or `rejected` **and** its `source` flipped to `'human'`. The prior row is preserved in the `audit_log` `before` snapshot. This means the ingestion worker's classify stage can never overwrite a human decision: the classify stage skips any row with `source='human'` or `source='external'`.

### 11.7 Lifecycle actions and /reindex

Promote (`needs_review → searchable`) and withdraw (`searchable → withdrawn`) are consistent on the next query under the default `KEYWORD_BACKEND=sparse` — both lanes filter `status='searchable'` per-query, so no reindex is needed for UI-driven or direct psql status changes.

The admin status route fires a **non-blocking, fire-and-forget** `POST /reindex` on promote (status → `searchable`) only — purely to refresh the service's in-memory passage-context texts; the API response has no `reindex` field, the route never awaits the call, and the UI shows no staleness notices (both retrieval lanes are already consistent per query). Withdraw fires nothing. The worker's publish stage calls `/reindex` for the same passage-text reason (with one retry on `409 already_running`; build-then-swap, seconds under sparse mode). Under `KEYWORD_BACKEND=memory` (legacy path) `/reindex` also rebuilds the in-memory BM25 index, and a manual call after admin lifecycle changes is required for keyword-lane correctness in that mode (see §4).

### 11.8 Deferred

The following items were not built in Phase 2 (owner unassigned):

- Hard purge (permanent deletion of document rows and S3 objects)
- CSV/JSON export of catalog or audit log
- Corpus-health dashboard
- Audit-history UI (the `audit_log` table is populated; no read surface in the UI)
- Summary editing
- Per-collection bulk operations
- Taxonomy rename/merge and version bumps
