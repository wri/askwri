# AskWRI Document Management System — Comprehensive Design

**Date:** 2026-06-09
**Status:** Comprehensive design for review
**Supersedes/consolidates:** the 2026-06-09 working notes (redesign, multilingual-and-collections, scope-and-architecture, document-understanding, design-review), now in `docs/plans/archive/` for reference. This document is the single authoritative spec for the document management system. See also `2026-06-09-implementation-handoff-requirements.md`.

---

## 1. Purpose and goals

AskWRI is a research interface over WRI's published corpus (currently transport decarbonization). This effort rebuilds the **document management system** — how documents are ingested, stored, described, classified, organized, and maintained — so it can scale and go multilingual without the constraints of the current design.

Drivers:
- **Scale:** from ~170 documents today to a target of **1–5k**, with headroom designed in.
- **Multilingual:** support **English, Spanish, Chinese, and Portuguese** across the full pipeline.
- **Robust metadata store:** move off a single flat CSV to a proper system of record.
- **Automatic classification:** a robust auto-tagging system that can absorb *new* metadata types over time.
- **Manageability:** a self-serve admin experience so non-engineers can add, organize, and update documents.
- **Collections:** a first-class way to group documents for finding, managing, and updating.

The corpus is **predominantly scientific papers — figure- and table-heavy** — which shapes the ingestion design more than any other single fact.

## 2. Scope

**In scope (document management):** ingestion (upload/import, extraction, OCR + quality gating, language detection, dedup), the metadata store and schema, classification/tagging, collections, document lifecycle (versioning, supersession, cross-lingual variants, takedown), the admin UI, and producing derived artifacts (chunks + dense/sparse embeddings).

**Out of scope (separate workstreams, referenced where they touch us):** retrieval tuning (RRF weights, reranker selection), relevance thresholds/tiers and their recalibration, answer synthesis (answer/cite/why/relates/alignment), and the evaluation framework. We define the *hooks* these need but not their internals.

**On the seam — extraction & chunking** serve both ingestion and retrieval. Document management owns *producing clean, structured, chunked, embedded content and its metadata*, judged by "did we extract correctly." How that content is ranked and synthesized belongs to retrieval.

## 3. Current state (confirmed from the code)

- **No LlamaCloud.** `askwrimvp` runs a self-hosted Python `search-service` on the LlamaIndex *libraries*; `llamaindex-client.ts` is commented "direct replacement for LlamaCloud," and there is no `LLAMA_CLOUD_*` config. `llamacloud.ts` / `pipeline_file_id` are legacy names.
- **Metadata is a flat CSV.** `documents.csv` (file_path, metadata JSON blob, summary) is read fully into memory. Schema already includes a `languages` field on every row.
- **Ingestion is fused into the retrieval service's startup.** `build_indexes()` reads the CSV, parses each PDF locally with LlamaIndex `PDFReader`, chunks, embeds via OpenAI, caches to S3, and builds in-memory dense + BM25 indexes **at boot** — rebuilt on every restart.
- **No admin/ingestion UI.** Documents are produced offline; the CSV and PDFs are the only handoff between "doc management" and "indexing."
- **Production infra exists and is good:** AWS ECS Fargate, Terraform, CI/CD, **RDS Postgres** (used only for query logs + feedback), S3, and a real evaluation framework. RDS is a provisioned relational database we are barely using.

The core problems: CSV-as-database, rebuild-at-boot indexing fused to retrieval, and no ingestion/management tooling.

## 4. Design principles

1. **Separate the three concerns** the current system fuses: doc-management CRUD, ingestion/indexing, and retrieval.
2. **Postgres is the system of record.** Reuse RDS for metadata *and* vectors (pgvector). One transactional source of truth; S3 for blobs.
3. **Incremental, not rebuild.** Ingesting a document is a set of row inserts; it becomes searchable immediately. No boot-time index rebuilds.
4. **Capture-rich, decide-late.** Persist enough at ingest (native text, raw chunks, per-chunk language, English renditions, structured tables) that model and strategy choices can change later *without re-ingesting*.
5. **Everything swappable behind provider interfaces.** Embedding, sparse, reranker, and PDF parser are providers, not fixtures — chosen by evidence, replaceable by config + re-embed/re-parse.
6. **Human-in-the-loop.** Auto-extraction and auto-tagging produce *suggestions* with provenance and confidence; humans correct and approve. Human decisions are immutable to automation.

## 5. Architecture

Three concerns, split by runtime where it genuinely differs:

| Concern | Component | Responsibility |
|---|---|---|
| Doc-management CRUD / admin | **App tier** — Next.js + TypeORM | Admin UI; relational CRUD (documents, collections, tags, jobs); catalog API; enqueues ingestion jobs. Owns the relational schema + migrations. |
| **Ingestion / indexing** | **Ingestion worker** — Python | Queue-driven async pipeline: parse → extract → detect language → dedup → chunk → summarize → classify → embed (dense+sparse) → upsert chunks → mark searchable. PDF/ML-heavy; Python-native. |
| Retrieval / search | **Search service** (existing) | Query-time hybrid retrieval + rerank. Reads from Postgres instead of rebuilding at boot. Retrieval *tuning* is a separate workstream. |

**Stores:** RDS Postgres (relational + pgvector dense `vector` and sparse `sparsevec`) as system of record and vector store; S3 for source PDFs, extracted text, and page images.

**Write ownership — one owner per domain** (prevents two-writers-one-DB drift):
- App tier owns relational truth: `documents`, `collections`, `document_collections`, `tags`, `document_tags`, `ingestion_jobs`, `document_relations`.
- Ingestion worker owns derived artifacts only: `document_chunks` (text + embeddings). It touches relational tables only to update `ingestion_jobs.status`.
- Vector-column DDL is declared in TypeORM migrations as custom types, so schema has a single source even though the worker writes those rows via raw SQL.

**Queue:** a Postgres-backed job table polled with `SELECT … FOR UPDATE SKIP LOCKED` suffices at this scale; SQS only if managed retries/DLQ are wanted.

## 6. Data model

All tables in RDS Postgres. `pgvector` ≥ 0.7.0 for `sparsevec` (RDS supports 0.8.0 today on PG 16.5+/15.9+ etc.).

```sql
-- System of record: one row per document (a specific manifestation)
documents (
  id              uuid primary key,
  doi             text,
  external_id     text,                           -- legacy id / source id
  s3_key          text not null,                  -- source file
  title           text,
  title_en        text,                           -- always populated (display/sort convenience)
  abstract        text,
  language        text,                            -- primary, ISO 639-1
  languages       text[],                          -- all detected
  year_published  int, publication_title text, article_type text,
  wri_primary_office text,
  content_hash    text,                            -- dedup key
  extraction_confidence numeric,                   -- quality-gate score
  status          text,  -- draft|processing|needs_review|searchable|withdrawn|error
  created_at timestamptz, updated_at timestamptz
)

-- Per-language summaries (native + English; one paper = one document in its original language)
document_summaries (
  document_id uuid references documents(id) on delete cascade,
  language    text,            -- ISO 639-1; always includes the native language and 'en'
  kind        text,            -- long | short
  text        text,
  source      text,            -- generated
  model_version text,
  primary key (document_id, language, kind)
)

-- Retrieval unit; owned by the ingestion worker
document_chunks (
  id            uuid primary key,
  document_id   uuid references documents(id) on delete cascade,
  chunk_index   int,
  unit_type     text,           -- text | table | figure | summary
  unit_number   text,           -- "Table 3", "Figure 2"
  section_path  text,           -- "3.2 Results > Emissions"
  page          int,
  caption       text,
  text          text,           -- linearized/searchable text
  structured    jsonb,          -- table as HTML/markdown + parsed cells; figure descriptor
  language      text,
  embedding         vector,     -- dense; dimension per embedding_model
  embedding_model   text,
  dimension         int,
  sparse        sparsevec,      -- BGE-M3 learned sparse weights
  tsv           tsvector        -- optional FTS fallback
)

-- Controlled vocabulary (facets), versioned; supports categorical + typed attributes
tags (
  id uuid primary key,
  facet text,                   -- topic | sector | geography | program | doc_type | ...
  value_id text,                -- stable canonical id (English label for now)
  taxonomy_version text
)

-- Typed attributes for non-categorical metadata (dates, numerics, geo, entities)
document_attributes (
  document_id uuid references documents(id),
  key text, type text,          -- date|number|geo|entity|text
  value_text text, value_num numeric, value_date date, value_json jsonb,
  source text, confidence numeric, model_version text
)

-- Many-to-many tags with provenance
document_tags (
  document_id uuid, tag_id uuid,
  source text,                  -- human | llm
  confidence numeric, model_version text,
  status text,                  -- suggested | accepted | rejected
  created_at timestamptz
)

-- Curatorial containers
collections (
  id uuid primary key,
  name text, slug text, description text,
  owner text, visibility text,  -- private | internal | public
  language_policy jsonb,        -- {primary:'en', index_native:true}
  embedding_model_version text, -- enables per-collection A/B and staged migration
  created_at timestamptz, updated_at timestamptz
)
document_collections ( document_id uuid, collection_id uuid, added_by text, added_at timestamptz )

-- Durable ingestion queue
ingestion_jobs (
  id uuid primary key, document_id uuid,
  stage text, status text,      -- queued | running | needs_review | done | error
  error text, attempts int, model_versions jsonb,
  created_at timestamptz, updated_at timestamptz
)

-- Admin users + simple role-based access (username/password now; SSO later behind an interface)
users (
  id uuid primary key,
  username text unique, email text,
  password_hash text,           -- argon2/bcrypt
  role text,                    -- admin | editor
  active boolean, last_login timestamptz, created_at timestamptz
)

-- Append-only audit of every mutation (subsumes per-import audit)
audit_log (
  id bigserial primary key,
  actor_user_id uuid,           -- null for system/llm
  source text,                  -- human | external | llm | system
  action text,                  -- create | update | delete | purge | tag_decision | import | lifecycle | collection_change
  entity_type text, entity_id uuid,
  before jsonb, after jsonb,    -- field-level diff (coarse ref + count for bulk ops)
  at timestamptz default now()
)
```

Design notes:
- **One paper = one document in its original language** (confirmed assumption). No multi-language manifestations of the same paper, so there is no `works`/translation-grouping model — each document stands alone, with an English summary/title generated for display and retrieval (not a separate document). Versioning and a `works` grouping can be added later if the assumption changes.
- **`document_attributes`** is the answer to "new types of metadata": typed values, not just categorical tags, so dates/numerics/geo/entities have a real home. (Deferred past the lean core — see §20.)
- **Dimension/model per chunk row** is what makes the embedding model swappable in place (old and new vectors coexist; cut over per collection).
- CSV does not disappear as a *format* — a one-click CSV/JSON **export** preserves the portability the old design valued, without CSV as the live store.

## 7. Ingestion pipeline

A queue-driven, idempotent, resumable pipeline in the Python worker. Each stage records status on `ingestion_jobs`; failures route to review, not silent corruption.

**7.1 Intake — bulk-first.** Three ingress modes, all of which can take many documents at once:
- **Folder / multi-file upload** in the admin UI (select or drag a whole folder of PDFs).
- **S3 bulk drop** — files placed in a watched prefix are picked up by the worker (for large batches without the browser).
- **Metadata-driven import** — Zotero/CSV/RDI-mastersheet sidecar matched to files (preserves the prior workflow).

Each file becomes its **own durable ingestion job**, so a folder of hundreds is N incremental jobs (no all-or-nothing, no rebuild), grouped as a batch in the job monitor for progress tracking and selective retry. Source file → S3; a `documents` row is created in `draft`. Because extraction derives metadata (GROBID: title, authors, DOI, abstract), a **bare folder of PDFs with no sidecar** is a valid input — the pipeline fills metadata in and routes low-confidence results to review; a provided sidecar (Zotero/RDI fields) simply seeds metadata up front.

**7.1a Authoritative metadata import (external systems of record).** Some teams curate metadata in an external system (Zotero, an RDI mastersheet) and want it trusted as-is rather than re-derived from files. This is supported by separating **content extraction** (chunks/tables/embeddings — always runs, required for retrieval) from **descriptive metadata** (which, here, comes from the import). Mechanics:
- A **canonical metadata CSV**: one documented format with a stable **match key** (DOI or `external_id`), plus a downloadable template; raw Zotero exports are mapped to it by an adapter rather than ingested directly.
- **Two modes, per import:** *seed* (CSV seeds; extraction may enrich/override per confidence — the default for new files) vs. **authoritative** (CSV is source of truth for the fields it contains, recorded `source=external`; LLM metadata extraction is **suppressed for those fields** and may only fill blanks the CSV leaves).
- **Upsert against existing documents** by match key, so a team can **update metadata en masse without re-uploading files**.
- **Dry-run preview** first (per-field change report), applied transactionally, with an audit trail (who, when, which fields, prior values) for rollback.
- **Precedence:** `human` (in-app edits) > `external` (import) > `llm` by default — an authoritative import overrides LLM-derived values but not an admin's manual corrections. An opt-in "treat external as system of record" lets a re-import also supersede prior human edits for teams that want the external source to be absolute.
- A recurring **sync connector** (poll/extract from Zotero on a schedule) is a possible later addition; the one-shot canonical-CSV import is the foundation.

**7.2 Extraction (scientific-paper optimized — two stages).** Because the corpus is figure/table-heavy scientific papers, extraction is the highest-leverage stage; retrieval quality is capped by it.
- *Structure + metadata (GROBID):* deterministic extraction of title, authors, abstract, DOI, journal, section hierarchy, figure/table captions, and references as structured TEI. Feeds the metadata store, the dedup/identity key (DOI), and a future citation graph (references).
- *Layout + tables/figures (pluggable parser):* a layout-aware parser (LlamaParse hosted — now permitted — or Docling/Marker local) produces structured Markdown/JSON with **tables reconstructed (HTML, colspan/rowspan), figures with captions and bounding boxes, and page numbers.**

**7.3 Tables and figures as first-class units** (the crux for "the answer is in Table 3"):
- Each **table → its own chunk**: caption + structured table (Markdown/HTML) + a short LLM summary, with *context enrichment* (column headers concatenated with values so rows self-describe). Structured cells preserved in `structured` for display/verification.
- Each **figure → its own chunk**: caption + optional VLM-generated description.
- Body text → **structure-aware chunking**: chunk on section boundaries, keep the abstract whole, attach `section_path` + `page`, never split a table across chunks.

**7.4 Language detection + normalization.** Detect primary language and the set present, at document *and* chunk level. Chinese is handled **Simplified-canonical with OpenCC** Traditional→Simplified normalization at ingest (store original for display, index normalized) so script variants are not a branch point.

**7.5 Summaries and renditions.** Generate summaries for every document in the **native language and English** (long + short), plus `title_en`, all at ingest. Two rules:
- **Summarize from the source, not by translating the summary** — produce the English summary by summarizing the original document in English (and the native summary in its own language). Translate-the-summary compounds loss; summarize-in-target-language is higher fidelity.
- **Native + English only by default** (English is the bridge language); the multilingual embedder covers Spanish/Portuguese/Chinese *queries* against those renditions, so per-document summaries in all four languages are unnecessary. Storing them in `document_summaries` keyed by language means adding a UI display language later is *data, not a schema change*.

These serve both **display** (an English-reading user can read any document) and **retrieval**: the summary text is canonical in `document_summaries`, and its **embeddings are written as doc-level `document_chunks` rows** (`unit_type='summary'`, one per language) so both the dense spaces and the within-language sparse lane have a handle on every document. Everything is precomputed — **no query-time translation**, so latency is unaffected; regenerate only on source change or added language.

**7.6 Deduplication and identity.** Compute `content_hash`; check for existing manifestations by DOI/title. Distinguish true duplicates (block/merge) from **new versions** and **translations** (link via `works` + `document_relations`, not rejected). This is a DB query, not the old O(n·m) scan.

**7.7 Classification (see §8).** LLM structured tagging + typed attribute extraction against the controlled vocabulary.

**7.8 Embedding.** Compute per-chunk **dense** vectors (pluggable model) and **BGE-M3 sparse** weights; store as `vector` + `sparsevec`. Batch step — no query-time cost.

**7.9 Quality gate + review queue.** Score `extraction_confidence` from cheap signals (GROBID found title/abstract/sections? tables well-formed? text density per page sane? language consistent?). Low-confidence docs land as `needs_review` in the admin queue rather than polluting the corpus. This is the concrete handling of the broken-PDF tail.

**7.10 Publish.** On success, status → `searchable`; chunks are immediately queryable (incremental, no rebuild).

## 8. Classification and tagging

A **controlled vocabulary + LLM structured extraction + human-in-the-loop** system, designed to absorb new metadata types.

- **Taxonomy** (`tags`, versioned): facets for topic, sector, geography, WRI program, document type, plus room to add facets without schema change. **Language-neutral**: one canonical `value_id` per concept (English label for now) regardless of a document's language, so a Chinese and an English paper on the same topic carry the same tag. Translating the tag labels into other UI languages is deferred (§20).
- **Seed from existing data:** bootstrap the vocabulary from the corpus's existing `wri_programs`, `wri_primary_office`, `Sub-tag`, `article_type`.
- **LLM classification:** structured-output call constrained to the vocabulary returns tag values + confidence per facet; geography can add NER. Cross-lingual by design (any-language content → canonical ids).
- **Typed attributes** (`document_attributes`): for non-categorical metadata — dates, numerics, geocoordinates, named entities, extracted key findings — so "new metadata types" aren't forced into a categorical shape.
- **Provenance + precedence:** every tag/attribute/field records `source` (`human` | `external` | `llm`), `confidence`, `model_version`, `status` (suggested/accepted/rejected). Precedence is `human` > `external` > `llm` (see §7.1a); low-confidence LLM values → review, not auto-apply.
- **Human-in-the-loop:** admin UI surfaces suggestions for accept/edit/reject; human values win and are immutable to the LLM. Externally-imported authoritative metadata is likewise protected from LLM overwrite.
- **Versioned + re-runnable:** because taxonomy + model versions are recorded, adding a facet later means re-running classification *for that facet only* — not re-ingesting.
- **Governance (open):** an owner for the controlled vocabulary and a policy for re-tagging when it changes.

## 9. Collections

Collections are **curatorial containers** — distinct from tags (descriptive facets). Keeping them separate prevents everything collapsing into tags.

| | Tags | Collections |
|---|---|---|
| Nature | Descriptive facets | Curatorial containers |
| Origin | Mostly auto + human correction | Human-defined, owned |
| Cardinality | Many per doc | A doc in one or more |
| Use | Faceted filtering, classification | Management, scoping, permissions, bulk ops |

Value for the stated goals:
- **Find:** scope a query to one or more collections (e.g., "World Resources Report", "LAC office") — more intuitive than composing tag filters; supports default scopes per surface.
- **Manage:** ownership and (later) permissions attach to a collection, not thousands of loose docs.
- **Update:** bulk operations per collection — re-tag, re-embed, regenerate summaries, re-OCR, export, delete.

Collections also carry a **language policy** and an **embedding-model version**, which enables clean **A/B and staged migration**: embed a candidate collection with a new model while production stays put; migrate legacy docs as one collection and cut over per collection. Recommend **flat collections + tags for facets** rather than nested trees (nesting recreates the taxonomy problem tags already solve) — pending validation against how WRI staff actually organize.

## 10. Multilingual handling

Language is a pipeline-wide decision, not a model setting. Languages: **English, Spanish, Chinese, Portuguese.**

- **Dense retrieval — pluggable, cross-lingual.** A multilingual embedder puts "transport"/"transporte" in one space, so any-language queries retrieve any-language docs. Hosted models lead on dense quality (Voyage-3-large, Cohere embed v4); for **Chinese**, Chinese-origin open models top C-MTEB. Choice deferred to an evidence-based bake-off; pluggable either way.
- **Sparse retrieval — solved once via BGE-M3 + `sparsevec`.** BGE-M3 emits multilingual-aware learned sparse weights, removing the per-language Postgres-FTS problem (CJK especially). Run BGE-M3 for the sparse lane **regardless of the dense choice**; precompute at ingest, store as `sparsevec`. Query encode is ~50ms.
- **Reranker — multilingual cross-encoder** (BGE-reranker-v2-m3 today), behind the provider interface.
- **Script normalization:** Chinese Simplified-canonical via OpenCC (§7.4).
- **English renditions** for every doc (§7.5).
- **One document per paper in its original language** (confirmed): no translated-document variants to reconcile; the English summary/title serves display and the English retrieval handle.
- **CJK-specific ingestion work:** OCR language packs, tokenizer-aware chunking — driven by the Chinese requirement.
- **Retrieval-side consequences (flagged, owned by the retrieval workstream):** relevance thresholds/tiers are English-calibrated and will need per-language recalibration; answer synthesis should reply in the query language and display original snippet + translation.

## 11. Provider abstraction

A thin interface isolates every model/tool choice so none is a fixture:
- `EmbeddingProvider.embed(texts) → vectors` (+ `dimension`, `model`)
- `SparseProvider.sparse(texts) → weights` (default BGE-M3; falls back to Postgres FTS if a future model lacks sparse)
- `RerankProvider.rerank(query, passages) → scores`
- `ParserProvider.parse(pdf) → {structure, chunks, tables, figures}` (GROBID + layout parser behind one interface)

Swapping a model is a config change plus **re-embed**; swapping a parser is a config change plus **re-parse** — both replay only their stage because native text and raw chunks are persisted. No re-ingestion, no schema change (dimension stored per row). Staged per collection via `embedding_model_version`.

## 12. Document lifecycle

"Manage and update" is a primary goal, so lifecycle is first-class, not just upload-dedup:
- **Retraction / takedown:** `withdrawn` status removes from retrieval while preserving the record and audit trail.
- **Freshness:** `year_published` and ingest timestamps support recency signals (used by retrieval).
- **Re-processing:** taxonomy or model-version changes trigger targeted re-runs (re-tag / re-embed / re-parse) via the job queue, scoped by collection.
- **Delete vs. purge:** **soft delete / withdraw** is the default — out of retrieval and default catalog views, record + chunks retained, reversible. **Hard purge** is admin-only and deliberate — permanently removes chunks/embeddings/summaries and the S3 source/derived files, leaving an **audit tombstone** (id, title, actor, time, reason). Use purge for mistaken uploads or true removal; everything else withdraws.
- **Re-upload idempotency:** intake computes `content_hash`. Identical hash → **skip** (re-dropping an S3 folder or retrying a batch is safe); same DOI/title but different content → offered as a **new version** under the work, never a silent overwrite; ambiguous cases route to the dedup/version resolver. Bulk imports report skipped/updated/new counts.
- **Embargo / publication state:** deferred — AskWRI is an internal-only tool, so there is no public/embargo layer. Retrieval still serves only `status=searchable`; `draft`/`needs_review` documents are simply not yet live.
- **Versioning / works grouping:** deferred. Under the "one paper = one original document" assumption there are no translation variants, and document versioning/supersession can be added later (a nullable `work_id` + a relations table) if revisions become common.

## 13. Admin experience

The self-serve surface (app tier) over the whole model:
- **Intake:** drag-drop folder/multi-file upload, S3 bulk drop, and metadata import (canonical CSV; Zotero/RDI adapter), with pre-commit dedup/version/translation resolution.
- **Metadata import / en-masse update:** upload a canonical CSV in *seed* or *authoritative* mode to create or update many documents by match key, with a **dry-run preview** (per-field change report) before applying and an audit trail for rollback.
- **Review queue (system-surfaced corrections):** low-confidence extractions and tags pushed automatically for accept/edit/reject; native + English fields side by side; original page image for table/figure verification — so admins don't hunt for what's wrong.
- **Document editor (on-demand correction of anything):** open any document and correct it, with the **source PDF/page image shown side-by-side** with extracted metadata for verification; **field-level provenance + confidence badges** (human vs. LLM, confidence) so admins know what to scrutinize; inline editing of metadata, typed attributes, tags, language, collection membership; and lifecycle actions (new version, supersede, withdraw). Corrections are recorded as `source=human` and are **immutable to future LLM re-runs**, so fixes survive reprocessing.
- **Catalog + working sets (find and subselect):** a filterable/sortable table of all documents with key metadata columns; **facets for collection, tag, language, status, year**. Narrow the full list into a transient **working set**, then act on a selection — **bulk-edit fields**, add to a collection, **create a new collection from the selection**, or run bulk operations (re-tag, re-embed, regenerate summaries, export). Filters can be saved as views.
- **Collections manager:** create/rename, assign (single + bulk), set language policy + model version, run bulk operations, export. Collections are the durable named groups; a filtered working set can be promoted into one.
- **Job monitor:** ingestion job status, errors, retries, reprocessing controls; batch grouping for bulk uploads.
- **Access & roles:** username/password login (no SSO yet); `admin` (all operations incl. delete, authoritative import, user management) vs. `editor` (ingest, edit metadata/tags, manage collections; no delete or user management). Auth sits behind a thin interface so SSO can replace it later.
- **Corpus-health dashboard (admin home):** counts by status / language / collection, review-queue depth, failed or stuck jobs, extraction-failure rate, untagged or low-confidence docs, missing English renditions, and migration progress (docs not yet on the current embedding-model version). Each metric links to the matching filtered working set so it is actionable.
- **Document history + audit:** a per-document history tab (field-level who/when/what from `audit_log`) and a system-wide audit view; corrections, tag decisions, imports, lifecycle changes, and deletes are all recorded.

## 14. Migration from the current system

One-time, validated migration of the ~170 documents:
1. Parse `documents.csv` JSON blobs → normalize into `documents` (+ `works`), preserving existing `title`, `summary`, `short_summary`, `languages`.
2. Re-run extraction (GROBID + parser) on the source PDFs to populate `document_chunks` with table/figure structure the old flat text lacked.
3. Backfill: language detection validation, `title_en`/`summary_en`, auto-tags + typed attributes against taxonomy v1 (seeded from existing `wri_programs`/`wri_primary_office`/`Sub-tag`/`article_type`).
4. Load existing corpus as collection `legacy-transport-decarb`.
5. **Validate** against the existing golden sets: retrieval parity before cutover (this is where the retrieval workstream gates the migration).
6. Retain CSV export so nothing is lost in portability terms.

The search-service is repointed from "rebuild-at-boot from CSV" to "read `document_chunks` from Postgres," removing the boot bottleneck with no user-visible change.

## 15. Cost and operations

- **Per-document costs:** GROBID (free/CPU), layout parser (hosted per-page or local GPU), 2× summary LLM (native + English), tagging LLM, embeddings (hosted dense per chunk, or local). Bounded and one-time per doc (+ on re-embed/re-parse).
- **Per-query costs (retrieval-side, noted):** dense+sparse encode (~50ms), rerank, synthesis. Cache query embeddings.
- **Model serving:** BGE-M3 sparse + cross-encoder rerank run as one small always-warm service — CPU adequate at this corpus/QPS; GPU container only if rerank throughput demands. The reranker, not sparse, dominates query latency — keep rerank sets small and passages <512 tokens.
- **Re-processing at scale:** a model/taxonomy change can mean thousands of LLM/embedding calls — orchestrate through the job queue with rate limiting and per-collection scoping; surface cost estimates before bulk runs.
- **Ops:** RDS automated backups cover relational + vectors (one store to back up); HNSW build time/memory modest at our vector count; add retrieval-quality monitoring in production, not just pre-launch eval.

## 16. Evaluation hooks (workstream is separate)

Document management must *expose* what the eval workstream needs, even though eval internals are out of scope:
- Stable IDs and versioned chunks so golden sets stay valid across re-embeds.
- Labeled samples for **tagging precision/recall** and **extraction fidelity** (table cells correct, captions captured).
- Multilingual golden sets require **human labeling in four languages** — a resourcing question to flag early.
- `extraction_confidence` and tag confidence exposed for monitoring drift.

## 17. Roadmap

Staged delivery of the full design above (each phase independently shippable; the end state is sections 5–13).

- **Phase 0 — Store + migration (de-risk, no user-visible change).** Postgres schema (§6); migrate the ~170 docs (§14); repoint search-service to read pgvector; validate retrieval parity. Default providers wired (dense TBD, BGE-M3 sparse, GROBID + one layout parser).
- **Phase 1 — Durable ingestion + classification.** S3 upload, Postgres-backed jobs + worker, full pipeline (§7), auto-tagging + typed attributes (§8), quality gate + review states. Batch import path.
- **Phase 2 — Admin UI + collections.** The management surface (§13) and collections (§9), including review queue, bulk ops, export.
- **Phase 3 — Multilingual hardening + lifecycle.** Dense-model bake-off and selection (§10), OpenCC + CJK ingestion, cross-lingual variant linking, versioning/supersession/takedown (§12), multilingual review tooling. (Retrieval threshold recalibration happens in parallel in the retrieval workstream.)

Parser/model choices are swappable throughout (§11), so phases are not blocked on picking a "final" model.

## 18. Open decisions

1. **Dense embedding model:** Voyage vs. Cohere vs. BGE-M3, decided by a bake-off on a Chinese-anchored multilingual golden set (sparse held constant on BGE-M3). Governance to send text to third-party APIs is **cleared**.
2. **Layout parser:** hosted (LlamaParse) vs. local (Docling/Marker) — optionally checked on a small sample of real WRI papers; swappable, so not blocking.
3. **RDS engine version:** confirm it meets the pgvector 0.8.0 floor (PG 16.5+/15.9+) or plan a minor bump (the RDS instance is external to this repo's Terraform).
4. **Collections:** flat vs. nested — validate against WRI's actual organizational model.
5. **Auth/roles — resolved:** internal-only tool; username/password (no SSO) with `admin`/`editor` roles, behind a swappable auth interface; embargo/public-visibility deferred. (No retrieval-time ACL needed, so pgvector remains the right store.)
6. **Eval resourcing:** who produces multilingual golden sets and labeled samples.
7. **Equation handling:** are formula-heavy papers common enough to need VLM/Nougat-style math extraction, or are these mostly applied/policy papers where tables dominate?

## 19. Risks and mitigations

- **Extraction quality caps everything.** Mitigate with the two-stage parse, tables-as-units, the confidence gate + review queue, and a swappable parser.
- **Multilingual quality varies by language and degrades cross-lingually.** Mitigate with capture-rich ingest, BGE-M3 sparse, multilingual reranker, English renditions, and an evidence-based model choice validated per language.
- **pgvector outgrown** only if the corpus jumps ~100x (tens of millions of vectors) or retrieval-time ACL is required. Mitigate: Postgres stays system of record, so migrating the *index* later is "re-embed into a new engine," not a rebuild. pgvectorscale is an intermediate step.
- **Cost/latency creep** from LLM-heavy ingest and reranking. Mitigate with caching, batch precompute, small warm serving, and pre-run cost estimates for bulk reprocessing.
- **Two writers to one DB.** Mitigate with the one-owner-per-domain rule and TypeORM-owned DDL.
- **Taxonomy/threshold drift over time.** Mitigate with versioned taxonomy + model versions, re-runnable classification, and monitoring.

## 20. Complexity assessment and lean-core cut

**Verdict:** the architecture is right-sized (separation of concerns, Postgres system of record, pgvector hybrid, provider seams for the volatile bits). The *feature breadth* was the risk — built all at once it is a long road before value ships. The cut below keeps every original requirement while removing premature generality, so the implementation agent plans a thin end-to-end slice first.

**Lean core (build first — the walking skeleton):**
- Postgres schema for: `documents`, `document_chunks`, `document_summaries`, `tags`, `document_tags`, `collections`, `document_collections`, `ingestion_jobs`, `users`, `audit_log`.
- Migration of the existing ~170 docs; repoint the search-service to read `document_chunks` from Postgres (incremental, no rebuild-at-boot); validate retrieval parity on the golden sets.
- Ingestion worker with: folder/bulk + canonical-CSV intake, extraction (start with **one** parser; add GROBID only if metadata quality needs it), language detection + OpenCC, native + English summaries, controlled-vocabulary auto-tagging, dense + **BGE-M3 sparse** embedding, quality gate → review queue.
- **Full multilingual document support (EN/ES/ZH/PT)** — this is core, not deferrable: multilingual embeddings, the sparse lane for CJK, language detection, normalization, English renditions.
- Collections (create, assign, filter, bulk ops).
- Admin: catalog + document editor (source side-by-side, provenance/confidence), review queue, bulk upload, simple username/password auth with `admin`/`editor` roles. Write to `audit_log` from day one.

**Deferred until there is evidence of need (not in v1):**
- `works`/versioning/translation grouping and merge/split — removed under the "one paper = one original document" assumption.
- `document_attributes` (generic typed attributes) — start with categorical tags + fixed columns; add when a concrete typed metadata need appears.
- Tag-label localization (`tag_labels`) — canonical English labels for now.
- Authoritative-import precedence subtleties — start with seed import + simple overwrite; add `source=external` precedence + dry-run diff when a team actually drives metadata from Zotero/RDI.
- Corpus-health dashboard and audit/history **UI** — log the data from day one, build the views later.
- SQS / a dedicated model-serving fleet — use a Postgres-backed job table and one model-serving container; revisit only if volume demands.

This collapses v1 from ~14 tables to ~10 and removes roughly a third of the surface area with no loss to the stated goals (scale off CSV, multilingual, auto-classification, manageability, collections). The deferred items all attach cleanly later because the foundations (provider seams, Postgres SoR, audit from day one) are in place.

## 21. Sources

Local (current state): `askwrimvp/src/lib/llamaindex-client.ts`, `src/app/api/llamaindex/route.ts`, `src/app/api/catalog/route.ts`, `search-service/app/main.py`, `search-service/data/documents.csv`, `.env.example`, `terraform/infrastructure/`.

Models / retrieval: [BGE-M3 (HF)](https://huggingface.co/BAAI/bge-m3), [BGE-M3 paper](https://arxiv.org/html/2402.03216v3), [BGE-reranker-v2-m3 guide](https://localaimaster.com/blog/reranking-cross-encoders-guide), [C-MTEB](https://huggingface.co/C-MTEB), [C-Pack/BGE Chinese paper](https://arxiv.org/pdf/2309.07597), [voyage-3-large](https://blog.voyageai.com/2025/01/07/voyage-3-large/), [Voyage/OpenAI/Cohere/BGE comparison](https://www.buildmvpfast.com/blog/best-embedding-model-comparison-voyage-openai-cohere-2026), [RDS pgvector 0.8.0](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-rds-for-postgresql-pgvector-080/), [RDS pgvector 0.7.0 / sparsevec](https://aws.amazon.com/about-aws/whats-new/2024/05/amazon-rds-postgresql-pgvector-0-7-0/).

Extraction: [Best PDF parsers 2026 (Firecrawl)](https://www.firecrawl.dev/blog/best-pdf-parsers), [Docling vs Marker vs LlamaParse](https://codecut.ai/docling-vs-marker-vs-llamaparse/), [GROBID vs Docling](https://github.com/docling-project/docling/discussions/622), [OCR-to-Markdown eval (LlamaIndex)](https://www.llamaindex.ai/insights/ocr-to-markdown-evaluation), [Document extraction for RAG (LandingAI)](https://landing.ai/llms/document-extraction-for-rag-preparing-structured-outputs-for-vector-databases).
