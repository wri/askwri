# AskWRI Document Management — As-Built Reference

**Audience:** engineers working on Phase 1 or later.
**Phases covered:** 0 — Store + Migration (shipped); 1 — Ingestion + Classification (shipped).
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
| `document_texts` table (full text in Postgres, not S3) | `/query` needs each doc's full text in memory for passage-context extraction at query time. One transactional store beats re-introducing an S3 boot sync at this corpus size (~50 MB total). Revisit if corpus grows 10×. |
| `documents.source_metadata` jsonb | Stores the original CSV row verbatim (`{file_path, summary, metadata: {…raw keys…}}`). Lets the catalog API and future migrations access the original data without re-parsing CSV. |
| `document_chunks.corpus_order` integer (migration `1781290000000`) | BM25 breaks score ties by corpus position. The chunk load order from Postgres must reproduce the legacy node build order exactly. Populated by the migration script from `enumerate(nodes)`. **Reordering the migration script WILL silently change retrieval tail rankings.** |

### DEFERRED — in the design, not in Phase 0

Per design §20 lean-core cut:

- `works`/versioning/translation grouping — removed under "one paper = one original document" assumption.
- `document_attributes` (typed attributes table) — deferred; categorical tags + fixed columns for now.
- Tag-label localization (`tag_labels` table) — canonical English `value_id` only.
- Authoritative-import precedence subtleties (dry-run diff, `source=external` overwrite protection) — tags seeded with `source='external'`, `status='accepted'`; overwrite precedence logic deferred to Phase 1.
- `sparsevec` / BGE-M3 sparse lane — column exists in schema (`document_chunks.sparse`), not populated. BM25 stays in-memory (Phase 1 replaces it).
- GROBID / layout-parser ingestion pipeline — Phase 1.
- Admin UI, collections UI, auth — Phase 2.
- Dense-model bake-off, CJK ingestion, versioning/lifecycle — Phase 3.

---

## 3. Schema — the 11 tables

Two migrations: `1781280000000-Migration.ts` (initial 11 tables) and `1781290000000-Migration.ts` (`corpus_order` column + index). Both are TypeORM raw-SQL migrations under `src/db/migrations/`.

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
| `document_chunks` | Retrieval units (text chunks + embeddings). One row per chunk or summary node. | `id` (uuid PK), `document_id` (FK), `legacy_chunk_id` (unique, e.g. `2021_doc_chunk_0`), `chunk_index`, `unit_type` (`text`\|`summary`), `text`, `node_metadata` (jsonb, full legacy metadata verbatim), `embedding` (vector), `embedding_model`, `dimension`, `sparse` (sparsevec, unpopulated), `corpus_order` | Python migration script |
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
- **BM25 lane (in-memory):** the BM25 index is hydrated at boot (or `/reindex`) from the same `status='searchable'` rows. After a withdrawal, the BM25 index still holds the document's chunks until `/reindex` is called or the service restarts. Until then, a withdrawn document can surface in BM25 results and pass through to RRF fusion.

**Operational implication:** after withdrawing a document, call `POST /reindex` (or restart the service) to purge it from the BM25 lane. There is no automatic refresh.

---

## 5. Retrieval backends

Switched by `RETRIEVAL_BACKEND` env var in `search-service/app/config.py`.

| Backend | Value | Boot behavior | Dense lane | BM25 lane |
|---|---|---|---|---|
| Legacy | `legacy` (default) | Parses CSV + PDFs, builds in-memory indexes (cached; ~30 min cold) | LlamaIndex `VectorStoreIndex` in-memory | `BM25Retriever` over in-memory nodes |
| Postgres | `postgres` | Reads `document_chunks` from Postgres (seconds; no OpenAI calls) | `PgVectorRetriever` (SQL per query, pgvector HNSW) | `BM25Retriever` hydrated from Postgres chunk rows, ordered by `corpus_order` |

Both backends serve the same frozen `/query` contract (`QueryRequest`/`QueryResponse` in `search-service/app/main.py`). The `/reindex` endpoint re-runs the active boot path (re-reads Postgres in postgres mode; re-parses CSV in legacy mode).

`CATALOG_SOURCE=postgres` (app tier) switches `/api/catalog` from reading the CSV to reading `documents.source_metadata` from Postgres.

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

---

## 9. Phase 1 prediction corrections

The original Phase 1 prediction in this section was partially wrong. Actual outcomes:

- **Sparse lane (`document_chunks.sparse`):** NOT populated in Phase 1. The sparse/BGE-M3 swap is a separate eval-gated track, deferred pending bake-off results. BM25 remains in-memory.
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

### 10.4 Stage pipeline

| Stage | What it does |
|---|---|
| **parse** | PDFReader (LlamaIndex) → `document_texts` (`full_text`, `page_boundaries`). Sets document `status='processing'`. Falls back to title+summary text for CSV-imported docs with no associated file. If no text can be extracted at all, advances to `needs_review`. |
| **language** | langdetect; supported set: `{en, es, zh, pt, id}` (Indonesian added in Phase 1). Unsupported languages fall back to `en`. |
| **summarize** | Generates native-language + English long/short summaries via `WORKER_LLM_MODEL` (default `gpt-5-mini`), `source='generated'`. Skips rows that already exist (including CSV-seeded `source='external'` rows). For non-English docs, `title_en` is COALESCE'd to the original title — true translation is deferred. |
| **classify** | LLM call constrained to the `tags` taxonomy v1 values. Writes `document_tags` with `source='llm'`; `status='accepted'` if `confidence ≥ TAG_CONFIDENCE_ACCEPT` (default 0.7), else `status='suggested'`. Never touches rows with `source='human'` or `source='external'`. |
| **embed** | Phase 0-identical chunking: SimpleNodeParser 400/80 + summary node, legacy chunk id format, `node_metadata` verbatim, `text-embedding-3-small`. `corpus_order` appended after the current global max (advisory lock for concurrency). Re-ingest deletes prior chunks first. Chinese text and summaries are OpenCC t2s-normalized in chunks only (`document_texts` retains original). |
| **publish** | Computes `extraction_confidence = 0.4·density + 0.3·(language supported) + 0.3·(chunks>0)` where density = `min(chars_per_page / QUALITY_MIN_CHARS_PER_PAGE, 1)` (`QUALITY_MIN_CHARS_PER_PAGE` default 200). If `< 0.7`: document status → `needs_review`. Otherwise: document status → `searchable` + best-effort `POST SEARCH_SERVICE_URL/reindex` for BM25 lane (dense lane picks up new chunks immediately via SQL). |

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

A review UI is planned for Phase 2.

### 10.6 Worker env vars

| Var | Default | Purpose |
|---|---|---|
| `WORKER_LLM_MODEL` | `gpt-5-mini` | LLM used for summarize and classify stages |
| `WORKER_POLL_SECONDS` | `10` | Seconds between intake sweeps when running in continuous mode |
| `WORKER_MAX_ATTEMPTS` | `3` | Max stage attempts before job status → `error` |
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

CI (`pr-check.yml`) runs a `python-tests` job covering the hermetic/unit worker tests; DB-dependent worker tests self-skip when `DATABASE_URL` is absent (same pattern as the search-service tests).
