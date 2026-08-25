# Document Management — Scope and Service Architecture

**Date:** 2026-06-09
**Status:** Foundation for Phase 0
**Companions:** redesign / multilingual-and-collections / design-review docs (2026-06-09)

This doc locks the boundary of the work and the service architecture for the **document management** portion only. Retrieval and answer-quality are explicitly separate workstreams.

## Decisions locked this turn

- **Governance:** cleared to send document text to third-party services. Hosted embedding/LLM APIs are on the table; the dense-model bake-off (Voyage / Cohere / BGE-M3) is unblocked.
- **Evaluation:** retrieval/answer eval and multilingual threshold recalibration are a **separate workstream** with their own approach — out of scope here.

## Scope boundary

**In scope — document management:**
- Ingestion: upload + import (incl. Zotero/CSV/batch), text extraction, structure/table extraction (enough to populate metadata and clean chunks), OCR + extraction-quality gating, language detection, deduplication.
- Metadata: the Postgres store, schema, and catalog.
- Classification / tagging: controlled vocabulary, LLM auto-tagging, provenance, human-in-the-loop review.
- Collections: containers, membership, bulk operations.
- Document lifecycle: versioning, supersession, cross-lingual variants, retraction/takedown, freshness.
- Admin UX for all of the above.
- Producing derived artifacts: chunks + dense/sparse embeddings (generation only).

**Out of scope — retrieval / answer quality (separate workstreams):**
- Hybrid retrieval tuning, RRF weights, reranker selection.
- Relevance thresholds / tiers / logit calibration.
- Answer synthesis, why / relates / alignment.
- The evaluation framework.

**On the seam — extraction & chunking** serve both ingestion and retrieval. Doc management owns *producing clean, structured, chunked, embedded content and its metadata*, judged by "did we extract correctly." How that content is retrieved and ranked belongs to the retrieval workstream.

## Current state (confirmed from the code, 2026-06-09)

- **No LlamaCloud.** `askwrimvp` migrated off the LlamaCloud managed pipeline to a self-hosted Python `search-service` using the LlamaIndex *libraries* (`llamaindex-client.ts` is commented "direct replacement for LlamaCloud"; no `LLAMA_CLOUD_*`/`index_id`/`project_id` in env; `llamacloud.ts` and `pipeline_file_id` are legacy names).
- **Ingestion is fused into the search-service, not a standalone pipeline.** `build_indexes()` reads `documents.csv`, parses each PDF locally with LlamaIndex `PDFReader`, chunks, embeds via OpenAI, caches to S3, and builds in-memory dense + BM25 indexes **at startup**. The PDF→chunk→embed step lives in the same service that answers queries.
- **Doc management and indexing are joined only by `documents.csv` + the loose PDF files.** There is no admin/ingestion UI.

So three concerns are currently mis-split: doc-management CRUD = a CSV; **ingestion/indexing = fused into search-service boot**; retrieval = the search-service. The redesign re-draws these: pull ingestion out as its own async worker, make it incremental, and connect everything through Postgres instead of the CSV.

## Service architecture for document management

The deciding rule: **split a service only when the runtime genuinely differs; never split for organizational reasons.** The current "Python search-service" conflates two independent boundaries — *ingestion* and *retrieval*. Doc management only touches ingestion, which today is trapped inside the retrieval service's boot sequence and must be lifted out.

**Two components:**

1. **App / web tier — Next.js + TypeORM.** Admin UI; all relational CRUD (documents, collections, tags, ingestion jobs); catalog API; enqueues ingestion jobs. **Owns the relational schema and migrations.** Node's wheelhouse — synchronous, user-facing.

2. **Ingestion worker — Python.** Queue-driven async pipeline: PDF parsing → OCR + quality gate → structure/table extraction → language detection (+ OpenCC normalization) → dedup check → chunking → LLM title/summary (native + English) → LLM auto-tagging → dense + sparse (BGE-M3) embedding → upsert chunks/embeddings to pgvector → mark searchable. PDF- and ML-heavy, genuinely Python-native (layout parsers, FlagEmbedding/BGE-M3). It is a **worker**, not the request/response search service that pgvector made obsolete.

The retrieval-service question (consolidate into Next.js vs. keep a Python service) is a separate, retrieval-side decision and does **not** block document management.

**Write ownership — one owner per domain** (fixes the "two writers to one DB" risk):
- App tier owns relational truth: `documents`, `collections`, `document_collections`, `tags`, `document_tags`, `ingestion_jobs`.
- Worker owns derived artifacts only: `document_chunks` (text + dense `vector` + sparse `sparsevec`). It touches relational tables only to update `ingestion_jobs.status`.
- Vector-column DDL is still declared in TypeORM migrations (custom column types) so the schema has a single source of truth, even though the worker writes those rows via raw SQL.

**Queue:** a Postgres-backed job table polled with `SELECT … FOR UPDATE SKIP LOCKED` is sufficient at this scale; move to SQS only if managed retries / dead-letter handling is wanted. Either fits the design.

**Stores:** RDS Postgres (relational + pgvector) as system of record and vector store; S3 for source files and large derived artifacts (extracted text, page images).

## Open questions still owned by document management

1. **Document-understanding approach** (the "I don't know how to approach that" item, scoped to ingestion): how figure/table-heavy is the real corpus, and how large is the broken-PDF tail? This drives the extractor choice and the quality-gate/review-queue design. Recommend a small spike on a representative sample before freezing chunk/extraction schema.
2. **Lifecycle model:** how documents are updated/superseded in practice, and how EN/ES (etc.) versions of one report are represented (same-work-multiple-manifestations).
3. **Taxonomy:** owner and versioning policy; seed from existing `wri_programs`, `wri_primary_office`, `Sub-tag`, `article_type`.
4. **Metadata shape:** categorical tags only, or also typed attributes (dates, numerics, geo, entities)?
5. **Collections:** flat vs. nested — validate against how WRI staff actually organize.
6. **Auth/roles** for the admin surface (who can ingest, tag, manage collections).

## Next step

With governance cleared and the architecture set, the remaining blocker before a Phase-0 schema is the **document-understanding spike** (Q1). Recommend running it next, then freezing the schema for `documents`, `document_chunks`, `tags`, `collections`, and `ingestion_jobs`.
