# Document Management System — Ground-Up Redesign

**Date:** 2026-06-09
**Status:** Draft for review
**Scope:** Metadata store, ingestion + auto-tagging pipeline, multilingual retrieval, admin UI
**Repos reviewed:** `askwrimvp` (current), `askwri/mockups/askwri` (prior prototype)

## Locked constraints (from review + decisions)

- **Scale target:** low thousands (~1–5k documents), up from today's ~170.
- **Metadata store:** Postgres + `pgvector`, reusing the RDS instance already provisioned.
- **Ingestion:** self-serve admin UI for non-engineers.
- **Multilingual:** recommendation made below (single multilingual index).

## Why a port of the mockup fails

The mockup (`askwri/mockups/askwri`) is the only version with a real document-management layer — admin upload, Zotero import, 3-tier duplicate detection, LLM title/summary extraction, job queue. But it is built on two patterns that do not survive scale or concurrent ingestion, both flagged in its own `ARCHITECTURE.md`:

1. **CSV as database.** Metadata is JSON blobs in one `documents.csv`, loaded fully into memory. No transactions, no concurrent writes, O(n·m) duplicate detection.
2. **In-memory index rebuilt at boot.** Adding a document means regenerating all indexes (10+ min at 200 PDFs); the job queue is in-memory and lost on restart.

The current MVP (`askwrimvp`) dropped the admin tooling but kept *both* of these patterns — `search-service` still rebuilds BM25 + vector indexes in memory from `documents.csv` (an ephemeral `/tmp/askWRI_docs/documents.csv` path), and there is no ingestion UI at all. Porting the mockup would reintroduce exactly what we need to remove.

Two assets carry forward: the MVP's production infra (ECS Fargate, Terraform, CI/CD, RDS, S3) and its serious evaluation framework (golden sets, threshold calibration). The redesign keeps both.

## Core principle: separate the three concerns the current design fuses

| Concern | Today | New |
|---|---|---|
| System of record (metadata, tags) | flat CSV in memory | **Postgres (RDS)** |
| Blob store (PDFs, extracted text) | S3 (partial) / local | **S3**, canonical |
| Search index (dense + sparse) | rebuilt in memory at boot | **`pgvector` + Postgres FTS, incremental** |

RDS Postgres is already running but used only for query logs and feedback — we are paying for a relational database and not using it as one. Moving metadata and embeddings into it removes the rebuild-at-boot bottleneck: ingesting a document becomes a set of row inserts, and it becomes searchable immediately. At 1–5k docs × chunking, the vector table is on the order of 10⁵–10⁶ rows — comfortable for `pgvector` with an HNSW index.

The Python `search-service` stays — it holds the hybrid fusion, reranking, and eval logic worth preserving — but its backing store changes from "CSV → in-memory indexes" to "query `pgvector` + FTS in Postgres." Same retrieval brain, durable incremental store.

## Proposed data model (Postgres)

```
documents            -- one row per document (system of record)
  id (uuid, pk)
  external_id, doi, url, s3_key
  title, title_en              -- title_en always populated (see multilingual)
  summary, short_summary, summary_en
  language                     -- detected at ingest (ISO 639-1)
  year_published, publication_title, article_type
  wri_primary_office, status   -- draft | processing | searchable | error
  content_hash                 -- dedup key
  created_at, updated_at

document_chunks      -- retrieval unit
  id, document_id (fk)
  chunk_index, page, text
  embedding vector(N)          -- pgvector, HNSW index
  tsv tsvector                 -- Postgres full-text (sparse)

tags                 -- controlled vocabulary, versioned
  id, facet, value, taxonomy_version
  -- facet ∈ {topic, sector, geography, program, doc_type, ...}

document_tags        -- many-to-many with provenance
  document_id, tag_id
  source               -- human | llm
  confidence           -- 0..1 (llm)
  model_version, created_at

ingestion_jobs       -- durable replacement for the in-memory queue
  id, document_id, stage, status, error, attempts, timestamps
```

CSV does not disappear as a *format* — we keep a one-click CSV/JSON **export** so the portability the mockup valued is preserved, without using CSV as the live store.

## Automatic tagging / classification

The request for "robust automatic tagging for new types of metadata" is best served by a **controlled vocabulary + LLM structured extraction with human-in-the-loop**, not free-form tagging:

1. **Taxonomy** (`tags` table), versioned. Facets: topic/sub-tag, sector, geography/region, WRI program, document type, plus room for new facets without schema changes.
2. **LLM classification at ingest:** structured-output call (constrained to the controlled vocabulary) returns tag values with confidence per facet. Geography can additionally use NER for place extraction.
3. **Provenance + thresholds:** every tag records `source` (human/llm), `confidence`, and `model_version`. Low-confidence tags are flagged for review rather than auto-applied.
4. **Human-in-the-loop:** the admin UI surfaces suggested tags for accept/edit/reject. Human tags always win and are immutable to the LLM.
5. **Versioned + re-runnable:** because the taxonomy and model version are recorded, adding a new facet later means re-running classification only for that facet, not re-ingesting documents.

This gives auditable, correctable, extensible metadata — and validates cleanly (tagging precision/recall against a human-labeled sample).

## Multilingual recommendation

**Recommendation: one unified index over a multilingual embedding model, plus an always-populated English title/summary per document.** Not per-language indexes, not full-document translation at ingest.

Reasoning for WRI's likely profile (global institute; corpus observed in English and Spanish, with Portuguese/Chinese/French plausible across regional offices; queries predominantly English but regional staff may query in local languages):

- A **multilingual embedder** gives cross-lingual retrieval directly — an English query retrieves a Spanish document and vice versa — with no translation cost or fidelity loss. At 1–5k docs this is the simplest thing that fully meets the requirement.
- **Per-language indexes + routing** add real operational complexity (language detection on queries, N indexes, fallback logic) that is not justified below ~5k docs.
- **Translate-the-whole-document at ingest** is costly, lossy, and largely redundant once embeddings are multilingual.
- We still generate an **English title + summary for every document** regardless of source language. This is cheap, and it gives consistent display, a stable reranking/synthesis signal, and English-language browsing of a multilingual corpus.

Concrete pieces:
- **Embeddings:** a strong multilingual model — open option `BGE-M3` or `multilingual-e5-large`; managed option OpenAI `text-embedding-3-large` (adequate multilingual). Pick during Phase 3 by measuring against a multilingual golden set.
- **Reranker:** swap today's English cross-encoder for a multilingual one (`BGE-reranker-v2-m3`).
- **Sparse:** Postgres FTS with language-aware configs; for non-English, dense recall carries most of the weight.
- Detect and store `language` at ingest; optionally translate the *query* (cheap) to aid sparse matching.

Tradeoff to measure, not assume: multilingual embedders are marginally weaker than English-only models on English-only retrieval. The existing eval framework should quantify this before cutover.

## Phasing (each phase independently shippable)

- **Phase 0 — De-risk the store (no user-visible change).** Postgres schema; migrate the existing ~170 docs from `documents.csv` (normalize JSON blobs → tables; backfill language detection and v1 tags). Point `search-service` at `pgvector` + FTS instead of rebuilding from CSV. Validate retrieval parity against current golden sets.
- **Phase 1 — Durable ingestion + auto-tagging.** S3 upload, Postgres-backed `ingestion_jobs` + worker (or SQS, since we're on AWS), pipeline stages: extract → detect language → dedup (now a DB query) → title/summary incl. English → classify against taxonomy v1 → chunk + embed → upsert → mark searchable.
- **Phase 2 — Self-serve admin UI.** Rebuild the mockup's UI on the new backend: upload, dedup resolution, metadata + suggested-tag review/edit, per-document reindex, job status.
- **Phase 3 — Multilingual hardening.** Multilingual embedder + reranker, query handling, multilingual golden sets, re-tune thresholds.

## Validation plan

Extend the existing eval framework rather than inventing a new one: retrieval recall per language on golden sets; tagging precision/recall against a human-labeled sample; dedup accuracy (precision/recall on known duplicates); ingestion throughput and time-to-searchable; `pgvector` query latency at projected row counts.

## Open questions for next session

1. Embedding model choice drives the `pgvector` dimension and whether we self-host the embedder — confirm managed vs. open before Phase 0 freezes the schema.
2. Is the two-service split (Next.js + Python) worth keeping, or should retrieval consolidate now that the store is Postgres? (Leaning keep, for eval/rerank reuse.)
3. Taxonomy v1: who owns the controlled vocabulary, and is there an existing WRI tag list to seed it?
4. Worker substrate: Postgres-backed jobs (simplest) vs. SQS (more robust) — both fit; preference?
