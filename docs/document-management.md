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
| `document_texts` | Full extracted text per document (for query-time passage context). | `document_id` (PK, FK → documents), `full_text`, `page_boundaries` (jsonb), `char_count`, parse-cache stamps `parsed_content_hash` / `parse_backend` / `parse_model` (nullable; see the parse stage) | Python migration script |
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
- HNSW indexes on `document_chunks.embedding` — two partial indexes, one per model (`WHERE embedding_model = 'text-embedding-3-small'` and, since migration `1783454000000`, `WHERE embedding_model = 'cohere-embed-v4'`) so both models coexist through the embed cutover window; `ef_search` set to 1000 at query time for near-exact recall at this corpus size. Migration `1784815300000` retires the 3-small index, but **conditionally**: it drops only where the corpus holds zero `text-embedding-3-small` rows and otherwise no-ops with a `NOTICE`. qa completed the cohere cutover 2026-07-23 and drops it; production has NOT cut over and keeps it, since an unconditional drop there would strip the index serving its live dense lane. Re-running after the production cutover completes the retirement.
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

`CATALOG_SOURCE=postgres` (app tier, the default) switches `/api/catalog` from reading the CSV to reading Postgres.

**Catalog payload (issues #305/#306, 2026-07-29).** Each item keeps the legacy CSV envelope `{file_path, metadata: <json string>, summary}` for backward compatibility, and adds `meta.dms` — the first-class `documents` columns (`title`, `title_en`, `authors`, `year_published`, `date_published`, `publication_title`, `article_type`, `wri_primary_office`, `doi`, `url`, `language`, `languages`) plus the English `long`/`short` rows from `document_summaries`. **`meta.dms` is authoritative; `meta.metadata` is a frozen import artefact.** The research UI reads it through `normalizeCatalogRow` → `CatalogRow` in `src/app/utils/utils.tsx`, and `buildCatalogIndex` keys documents by `external_id` so `matchCatalogRow` matches `/query`'s `metadata.doc_id` exactly instead of guessing from filenames and titles.

This matters because `document_chunks.node_metadata` — and therefore every field `/query` returns — is built from `source_metadata` at embed time (`worker/stages/embed.py`). For worker-ingested documents that jsonb is sparse or absent, which is why the UI rendered "Unknown author", blank years and blank summaries; and where it does exist it is stale (pre-#303 bilingual titles, and three English documents whose CSV `languages` says `Chinese`). Any new UI metadata field must come from `meta.dms`, never from `meta.metadata` and never from the `/query` chunk metadata. `meta.dms.url` is deliberately NOT wired into `urlFrom` — it is the publication's landing page, while the Open-document and preview-iframe consumers need the in-app `/api/pdf` route.

**Keyword lane** (`RETRIEVAL_BACKEND=postgres` only) — controlled by `KEYWORD_BACKEND`:

| Value | Boot behavior | Query behavior |
|---|---|---|
| `sparse` (default) | No BM25 build; sparse vectors already in `document_chunks.sparse` | Per-query SQL with `WHERE status='searchable'` filter; requires `build_sparse_keyword.py` to have run |
| `memory` | Hydrates `BM25Retriever` from Postgres chunk rows at boot or `/reindex` | In-memory lookup; stale until next boot or `/reindex` |

Under `KEYWORD_BACKEND=sparse`, the `/reindex` endpoint no longer rebuilds the BM25 index. It refreshes in-memory passage-context texts and metadata (build-then-swap, ~11 s) used for answer synthesis — the admin promote route calls it on every flip to `searchable`, and the worker publish stage calls it only when restoring a re-ingested previously-searchable doc (retrying once on `409 already_running`; issue #310 removed the auto-publish path).

**English handles (`SPARSE_EN_HANDLES`, default `false` — cross-lingual, 2026-07-26):** when on, both sparse write sites (`scripts/build_sparse_keyword.py` and the worker embed stage) append English handle text to the **sparse tokenization string only** for `language != 'en'` docs: `documents.title_en` per chunk (skipped when it equals the indexed title after normalization — most zh docs) plus the curated English `long` summary on the summary chunk. Dense embeddings, stored chunk text, `node_metadata`, and `/query` are untouched; nothing on the query path reads the flag. The flag must be set consistently in the backfill shell AND the ingestion-worker env (two deploy surfaces) or the next re-ingest strips the handles. Rollback: flag off + one rebuild restores byte-identical sparse vectors (`keyword_vocab` keeps residual zero-weight rows — harmless). `scripts/sparse_parity_check.py` refuses to run flag-on (stored vectors intentionally diverge from raw-text BM25). Gate record: `docs/plans/2026-07-26-sparse-en-handles-gate-results.md`; design: `docs/plans/2026-07-26-sparse-lane-english-handles-design.md`.

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
- **GROBID / layout parser:** NOT adopted in Phase 1. PDFReader (LlamaIndex) was retained as the single parser.
  **Superseded 2026-07-22:** the parse bake-off (`docs/plans/2026-07-22-parse-bakeoff-phase0-results.md`, ratified) selected **Mistral OCR** as the Phase C parser behind the `PARSE_BACKEND` flag. GROBID remains not adopted.

  **Updated 2026-07-23 (Phase D executed):** the qa worker runs `PARSE_BACKEND=mistral`, and the full qa corpus was re-parsed — **168/168 docs are Mistral-parsed**, zero pypdf, zero `/gid` glyph garbage. The *code* default stays `pypdf` on purpose: flipping it would hard-fail every ingest wherever `MISTRAL_API_KEY` is absent (`worker/stages/parse.py` raises without it), so the backend is selected per-environment by worker env, not by a code default. pypdf remains permanently as the validation oracle. Production has not been re-parsed.
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
| **parse** | Dispatches on `PARSE_BACKEND` (multilingual-v3, 2026-07-22): `pypdf` (default — PDFReader/LlamaIndex text layer) or `mistral` (Mistral OCR markdown, per-page emission; parser page indices drive `page_boundaries`, fixing the zh page-attribution drift). Ratified parser for Phase C per the bake-off (`docs/plans/2026-07-22-parse-bakeoff-phase0-results.md`). Selected per-environment via worker env — qa runs `mistral` and its corpus is fully re-parsed (2026-07-23); the code default stays `pypdf` deliberately (see the parse-backend note above). Writes `document_texts` (`full_text`, `page_boundaries`). Sets document `status='processing'`. Falls back to title+summary text for CSV-imported docs with no associated file. If no text can be extracted at all, advances to `needs_review`. Also runs one structured-output LLM call that extracts `title`, `title_en`, `authors`, `doi`, `year_published`, `article_type`, `wri_primary_office`, each written under the `metadata_source` provenance guard (overwrite only when NULL/`llm`). Since issue #303 this stage owns the `title`/`title_en` pair: `title` is the native-language title **alone** and `title_en` the document's own English title when the cover carries one, else a translation — asking for a single "title" returned bilingual covers concatenated into both columns. Author names are transliterated to Latin script in the same call; native-script forms are not retained (a re-ingest re-extracts them). **Parse cache (issue #310 follow-up):** each write stamps `document_texts.parsed_content_hash` / `parse_backend` / `parse_model` (empty model for pypdf). On a later run, if all three match the document's current `content_hash` and the worker's current backend/model, the stage reuses the stored text and skips **both the S3 download and the OCR call**; metadata extraction and every downstream stage still run, so prompt-tuning re-ingests re-run the cheap stages only. Misses on NULL stamps (all pre-migration rows — that is what makes the migration behavior-neutral), NULL `content_hash` (CSV-era rows), changed bytes, a backend flip, or a change to the stamped `MISTRAL_OCR_MODEL` **string**. Two things the stamps deliberately do NOT track, both requiring `FORCE_REPARSE=true` (or a changed model string) to invalidate: a change to what the parse code *emits* under an unchanged backend (the 2026-07-22 per-page boundary fix is the precedent), and Mistral repointing the default `mistral-ocr-latest` alias — pin a dated model id per environment if you want that to invalidate on its own. `FORCE_REPARSE=true` bypasses the read path for a deliberate re-OCR. Making an existing corpus cache-eligible is a per-environment ops step (see `docs/runbooks/qa-push-deploy.md`), not a migration: the correct `parse_backend` value differs by environment. **Transport (2026-08-05):** the document is uploaded to Mistral file storage (`purpose='ocr'`) and referenced by a signed URL, then deleted after the call — it is NOT inlined as a base64 data URI. Base64 is 1.37x, so a 50MB PDF became a ~68MB request body, and it was never established whether the 50MB limit applies to the document or the body (i.e. whether the real raw ceiling was ~36MB). Uploading removes the question, verified against the live API, and drops peak per-parse memory by roughly two copies of the file. `scripts/batch_ocr.py` shares the same helper, so both transports submit documents identically. **Oversize shrink (issue #310 follow-up, mistral backend only):** Mistral OCR rejects files over 50MB (`MISTRAL_MAX_BYTES`). A PDF over that is passed through Ghostscript (raster images downsampled to 300 dpi — not the 150 dpi `/ebook` preset, which costs OCR legibility on small figure labels) and the **shrunk bytes are submitted to OCR only**; S3 and the app keep the original file. Ghostscript exit 0 is not trusted on its own — the output is re-read and rejected if it is empty, unreadable, or has fewer pages than the source (gs 10's repair path can silently drop pages, which would OCR clean and cache as complete). A shrunk parse stamps `parse_model` with a `+gs300` policy tag, so it is distinguishable from a full-resolution parse of the same bytes and **never hits the cache** — once the cap is raised, re-ingesting genuinely re-OCRs at full resolution rather than serving downsampled text forever. `WHERE parse_model LIKE '%+gs%'` finds every affected document. If `gs` is missing, fails, or cannot get the file under the cap, the stage raises with the sizes named and the job lands in the review queue. Note the reachable lane: the admin upload route still rejects >50MB at the door (`MAX_FILE_BYTES`, deliberately unchanged), so today this path only fires for files dropped directly into the S3 intake prefix, which has no size cap. Raising the upload cap is a separate decision to make **after** the mechanism is proven on the 59MB `wri-india-nup-report.pdf`. |
| **language** | langdetect; supported set: `{en, es, zh, pt, id}` (Indonesian added in Phase 1). Unsupported languages fall back to `en`. Long docs vote across head/middle/late windows (2026-07-22): WRI zh/es/pt reports open with English cover pages, and a head-only sample flipped `documents.language` to `en` on re-ingest. |
| **summarize** | Generates native-language + English long/short summaries via `WORKER_LLM_MODEL` (default `gpt-5-mini`), `source='generated'`. Skips rows that already exist (including CSV-seeded `source='external'` rows). Also a **fallback** writer of `title_en`, for documents the parse extraction never reached (CSV rows with no PDF; extraction-call failures) — it fires only when `title_en` is still blank: English docs get `= title`, non-English docs an LLM translation. Provenance-guarded via `metadata_source->>'title_en'` (overwrite only when NULL/`llm`; never `human`/`external`). Since issue #303 the parse stage owns the `title`/`title_en` pair and refreshes both together on re-ingest, so they never drift. |
| **classify** | LLM call constrained to the `tags` taxonomy v1 values. Writes `document_tags` with `source='llm'`; `status='accepted'` if `confidence ≥ TAG_CONFIDENCE_ACCEPT` (default 0.7), else `status='suggested'`. Never touches rows with `source='human'` or `source='external'`. |
| **embed** | Phase 0-identical chunking *parameters* (SimpleNodeParser 400/80 + summary node, legacy chunk id format). Dense model is model-aware since multilingual-v3 B1: `EMBEDDING_MODEL` selects `cohere-embed-v4` (Bedrock, the default and post-2026-07-22-cutover state) or `text-embedding-3-small` (OpenAI, rollback path); rows record `embedding_model`/`dimension`. Note: chunk *metadata* diverges from the Phase-0 migration in title source (worker uses `Publication Title` fallback, matching `indexing.build_nodes`; the migration used `Article Title`), authors (worker stores full, not truncated to 100), and `file_path` (worker stores the CSV `file_path`, not `s3_key`). `corpus_order` appended after the current global max (advisory lock for concurrency). Re-ingest deletes prior chunks first. Chinese text and summaries are OpenCC t2s-normalized in chunks only (`document_texts` retains original); page boundaries are recomputed on the Simplified text to avoid OpenCC length-change drift. Also writes sparse keyword vectors under the frozen corpus stats (new tokens get `df=1`); a token_id headroom guard **warns at 80% of `SPARSE_DIM`** and raises a clear error at the cap (run `build_sparse_keyword.py` or migrate the dimension). **After any BULK re-ingest, `scripts/build_sparse_keyword.py` must be re-run before any threshold derivation**: the stage assigns brand-new tokens `lucene_idf(1, n_chunks)` from the FROZEN `keyword_corpus_stats`, so a bulk run leaves both `n_chunks`/`avgdl` and the new tokens' IDF drifted from the real corpus. (Phase D 2026-07-23: stats were stale at 30,435 vs an actual 27,878 until rebuilt; vocab grew 190,070 -> 233,936.) If `keyword_corpus_stats` is missing (backfill never ran), it writes `NULL` sparse with a warning. When `SPARSE_EN_HANDLES=true`, English handle text (title_en per chunk; English long summary on the summary chunk) is appended to the sparse tokenization string only for non-EN docs — dense content and stored text are untouched (see §5). |
| **publish** | Computes `extraction_confidence = 0.4·density + 0.3·(language supported) + 0.3·(chunks>0)` where density = `min(chars_per_page / QUALITY_MIN_CHARS_PER_PAGE, 1)` (`QUALITY_MIN_CHARS_PER_PAGE` default 200). Since issue #310 ingestion **never auto-publishes a new document**: it parks at `needs_review` regardless of score (the job additionally parks in the review state only when `< 0.7`, so extraction concerns stay distinguishable from routine pending review), and only the admin promote route flips it to `searchable`. Exception — **re-ingest of an already-promoted doc**: parse records the pre-ingest status on the job (`ingestion_jobs.prior_status`, first write per job wins), and publish restores `prior_status='searchable'` docs to `searchable` when the score passes 0.7 (so `reingest_all` doesn't unpublish the corpus); a restore fires the same best-effort `POST SEARCH_SERVICE_URL/reindex` (one retry on `409 already_running`) as the promote route, because the live doc's chunks changed. A degraded re-parse (`< 0.7`) refuses the restore and parks. Withdrawn docs are never touched. |

### 10.5 Document lifecycle update

```
draft → processing (set by parse) → needs_review → searchable (human promote only)
                                          ↑              │
                      error (job exhausted retries)      └─ re-ingest: processing → searchable
                                                            (restored, score ≥ 0.7) | needs_review
```

Phase 0 migration set all existing documents directly to `searchable` (bypassing the pipeline). Since issue #310 the worker never auto-publishes: every newly ingested document waits in `needs_review` until a human promotes it; only a re-ingested previously-searchable document is restored to `searchable` automatically (see the publish stage row above).

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
| `SPARSE_EN_HANDLES` | `false` | English handles into sparse weights for non-EN docs (embed stage; must match the backfill's setting — see §5) |
| `SEARCH_SERVICE_URL` | — | Used by publish stage to trigger `/reindex` |
| `OPENAI_API_KEY` | — | Required for summarize and embed stages |
| `DATABASE_URL` | — | Postgres connection string |
| `FORCE_REPARSE` | `false` | Bypass the parse cache and re-OCR every document (see the parse stage) |

### 10.6b Bulk OCR via the Batch API (`scripts/batch_ocr.py`)

Gated ops script, 50% cheaper than per-document OCR ($2 vs $4 per 1k pages).
**Not for prompt-tuning re-ingests** — with the parse cache those already make
zero OCR calls. It pays off for a bulk NEW-corpus import, or a re-OCR campaign
after an OCR-model upgrade.

It selects documents that would MISS the parse cache (the same predicate
`_cached_parse` uses), uploads each PDF for a signed URL, submits one batch job
against `endpoint=/v1/ocr`, polls it, then writes `document_texts` **with the
cache stamps** and enqueues each document — so the follow-up pipeline pass runs
language→summarize→classify→embed→publish against a guaranteed cache hit and
never pays for OCR twice. Batch entries reference signed URLs rather than
inlining base64 (verified against the live API 2026-08-05): a 50MB PDF inlined
would be a ~67MB JSONL line, where the reference is ~500 bytes.

**Dry run is the default** — it prints the selected documents and the exact
JSONL/job payload, performing no uploads, no job, and no writes. `--execute`
opts in to spending money. Documents over the 50MB OCR limit are skipped and
left to the worker's Ghostscript shrink path, since a shrunk row is stamped
`+gs300` and would be re-OCR'd by the follow-up pass anyway.

**It refuses to run in two environments**, because in both the spend would be
wasted and a dry run would not reveal it (it would just list the whole corpus,
which reads like confirmation that they all need OCR):

- `PARSE_BACKEND != mistral` — the script stamps rows `mistral`, so under pypdf
  (the code default, and production's setting) every document looks like a cache
  miss and the follow-up pypdf parse would overwrite the OCR text just paid for.
- `FORCE_REPARSE=true` — the enqueued pass would bypass the cache and re-OCR
  everything synchronously at full price. Unset it, run the script, re-set it.

**Recovery.** The job id is logged at submission and the poll timeout repeats it.
If a run is interrupted after submission the work is already paid for — collect
it with `--resume-job <id> --execute`, which rebuilds the document map from the
database (`custom_id` is `external_id`) and writes the results. Partial results
from a `TIMEOUT_EXCEEDED` or `FAILED` job are collected too, rather than
discarded. The write-back commits per document, so a late failure keeps
everything already stored. Each write is guarded on the document's current
`content_hash`: a version replaced at intake mid-job is left alone rather than
overwritten with OCR of the superseded bytes. Uploaded copies are deleted from
Mistral storage when the job finishes, on every path.

```bash
cd search-service && ./venv/bin/python -m scripts.batch_ocr            # dry run
cd search-service && ./venv/bin/python -m scripts.batch_ocr --execute
cd search-service && ./venv/bin/python -m scripts.batch_ocr --resume-job <id> --execute
```

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

The admin status route fires a **non-blocking, fire-and-forget** `POST /reindex` on promote (status → `searchable`) only — purely to refresh the service's in-memory passage-context texts; the API response has no `reindex` field, the route never awaits the call, and the UI shows no staleness notices (both retrieval lanes are already consistent per query). Withdraw fires nothing. The worker's publish stage calls `/reindex` for the same passage-text reason (with one retry on `409 already_running`; build-then-swap, seconds under sparse mode) — but since issue #310 only on the re-ingest restore path, the one case where it flips a doc to `searchable`. Under `KEYWORD_BACKEND=memory` (legacy path) `/reindex` also rebuilds the in-memory BM25 index, and a manual call after admin lifecycle changes is required for keyword-lane correctness in that mode (see §4).

### 11.8 Deferred

The following items were not built in Phase 2 (owner unassigned):

- Hard purge (permanent deletion of document rows and S3 objects)
- CSV/JSON export of catalog or audit log
- Corpus-health dashboard
- Audit-history UI (the `audit_log` table is populated; no read surface in the UI)
- Summary editing
- Per-collection bulk operations
- Taxonomy rename/merge and version bumps
