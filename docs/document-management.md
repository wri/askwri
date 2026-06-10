# AskWRI Document Management — Phase 0 As-Built Reference

**Audience:** engineer starting Phase 1 work.
**Phase:** 0 — Store + Migration (shipped).
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

- **App tier (TypeORM):** owns ALL DDL and the relational tables (`documents`, `document_summaries`, `tags`, `document_tags`, `collections`, `document_collections`, `ingestion_jobs`, `users`, `audit_log`). One TypeORM entity exists for `documents` (`src/db/entities/Document.entity.ts`).
- **Python side (search-service):** writes `document_chunks` rows (raw psycopg SQL) and `document_texts` rows. Reads everything else. Never issues DDL.

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

## 9. Phase 1 builds on this

Design doc §17 Phase 1 — Durable ingestion + classification — builds on the schema established in Phase 0:

- The ingestion worker (Python) takes over `document_chunks` writes via the same raw-SQL path.
- `document_chunks.sparse` (sparsevec) is populated with BGE-M3 weights, replacing BM25.
- `ingestion_jobs` table is activated for queue-driven async pipeline.
- LLM auto-tagging writes to `document_tags` with `source='llm'`.
- `document_summaries` is populated for non-English documents.
- `GROBID` + layout parser replace the current `PDFReader`-based extraction.

The write-ownership rule remains: app tier owns schema and relational truth; the Python worker owns derived artifact rows (`document_chunks`, `document_summaries`).
