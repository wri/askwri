# Design Review — Gaps, Reconsiderations, Open Questions

**Date:** 2026-06-09
**Status:** Critical self-review of the redesign
**Companions:** `2026-06-09-document-management-redesign.md`, `2026-06-09-multilingual-and-collections.md`

A deliberate fresh look. The two design docs are strong on the *storage and retrieval mechanics* (Postgres+pgvector, hybrid lanes, multilingual, collections). That is also their blind spot: we optimized the plumbing and under-examined what flows through it. Below, ordered by how much each could change the plan.

## The biggest gap: document understanding, not document storage

We specified chunking as "tokenizer-aware" and moved on. But WRI's corpus is **report- and data-heavy** — working papers, multi-hundred-page reports, journal articles, and crucially **tables, figures, and charts where the actual answer often lives**. The prior repo literally contained a `2025-12-04-pdf-remediation-plan.md`, which tells us extraction quality is already a known pain. Retrieval quality is capped by extraction quality, and we have barely addressed:

- **Table and figure extraction.** A number in a table cell is frequently the answer to a research query. Naive text extraction flattens or drops tables. Need a structure-aware extractor (layout model / table parser) and a representation that keeps tabular data queryable.
- **Structure-aware chunking.** Chunk on document structure (sections, headings) not just token windows, and carry section/heading/page into chunk metadata for precise citation. WRI long-form reports especially need this.
- **The broken-PDF long tail.** Scanned, image-only, malformed, or OCR-garbage documents. Need a quality gate at ingest that scores extraction confidence and routes failures to human review — otherwise they silently poison retrieval.

This deserves its own design pass and probably a spike before schema is frozen. It likely matters more to answer quality than the dense-model choice we've been debating.

## Things we should reconsider

**1. Data governance may override the hosted-embedder recommendation.** We compared Voyage/Cohere/BGE-M3 on quality and latency and never asked whether WRI content *can* be sent to third-party APIs. Pre-publication working papers may be embargoed; some content may be confidential. If governance forbids shipping document text to an external embedding API, the dense-model debate collapses to "self-host BGE-M3," which also *simplifies* the architecture (one model for dense+sparse). **This question should come before the bake-off, because it may cancel it.**

**2. Whether the two-service split still earns its keep.** With pgvector holding everything behind a provider interface, the Python `search-service`'s original reason for existing (in-memory hybrid indexes) is gone. Retrieval becomes "two SQL queries + a rerank call." Meanwhile the eval framework already lives in TypeScript on the Next.js side, and we'd now have **two writers to one database** (TypeORM for metadata, Python for vectors) with a murky ownership boundary and split migrations. Reconsider consolidating retrieval into one service, or at least draw the write-ownership boundary explicitly. TypeORM also has no native `vector`/`sparsevec` type — those columns need custom types / raw-SQL migrations regardless.

**3. "Tags" may be too thin for "new types of metadata."** The request was a classification system for *new* metadata types. Categorical tags against a controlled vocabulary cover topic/sector/geography well, but not **typed attributes** (numeric ranges, dates, geocoordinates, named entities, extracted key findings/methodology). Consider a typed attribute model alongside tags, or we'll be forcing non-categorical metadata into a categorical shape.

**4. Relevance thresholds and tiers are calibrated for English.** The existing `2026-03-19-cite-logit-threshold-and-tiers` work tuned a raw-logit floor and Strong/Partial/Weak tiers on an English corpus. A multilingual reranker produces **different score distributions per language and for cross-lingual pairs** (recall the ~5–10 nDCG drop). Those thresholds will mis-fire on Chinese/Spanish/Portuguese. We need per-language (or language-aware) recalibration — an overlooked, concrete consequence of going multilingual.

**5. Flat collections vs. WRI's actual mental model.** We recommended flat collections + tags. But WRI may think hierarchically (program → project → output, or region → office). If so, flat collections force awkward workarounds. Worth validating against how staff actually organize before committing.

## Missing pieces (named so we don't rediscover them late)

- **Document lifecycle.** "Manage and update docs" was an explicit goal, and we only built *dedup at upload*. Missing: versioning/supersession (new revision of a working paper), retractions/takedowns, freshness/recency signals, and **cross-lingual duplicates** — the same report in English and Spanish is not a duplicate by the mockup's title/author/year rule, but users shouldn't get both as separate hits. This needs an explicit "same work, multiple manifestations" model.
- **Cost model + latency budget.** No end-to-end numbers. Per-document: native+English summary, auto-tagging, embeddings (×re-embeds on model swap). Per-query: dense+sparse encode, rerank, synthesis, why/relates/alignment, possible snippet translation. At 5k docs and interactive query rates these compound. We need a rough budget and query-time LLM caching, plus a defined latency target the reranker/GPU decision is measured against (we asserted "CPU fine" without a budget).
- **Model serving + ops.** Where do BGE-M3 and the cross-encoder run — CPU or a GPU container on ECS? HNSW build time and memory at our vector count; backup/restore of vector data; retrieval-quality monitoring in production (not just pre-launch eval).
- **Evaluation cost and ownership.** "Extend the eval framework" hides real work: multilingual golden sets need **human labeling in four languages**, and tagging precision/recall needs a human-labeled sample. Who owns this, and what's the budget? Eval is on the critical path for the dense-model decision but unresourced.
- **Permissions / auth / public-vs-internal.** We deferred ACL, but it shapes ingestion roles, the admin UI, and whether retrieval-time access control is ever needed (the one scenario where pgvector is *not* the best store). Need to know: is AskWRI public, internal, or mixed?
- **Taxonomy governance + bootstrapping.** Who owns the controlled vocabulary and how does it version when it changes (re-tag the corpus)? And we should *seed* it from existing metadata — the corpus already carries `wri_programs`, `wri_primary_office`, `Sub-tag`, `article_type`.
- **Migration correctness.** Backfilling language detection and tags onto the legacy ~170 docs, validating the existing `languages` field, and handling missing/dirty fields in the CSV JSON blobs — needs its own validation step, not just a load script.
- **Inter-document relationships.** WRI reports cite each other; "related/see also" links and citation graphs could add real value. Possibly out of scope, but flag it now.

## Open questions, prioritized for the next session

1. **Governance:** can document text be sent to third-party embedding/LLM APIs, or is self-hosting required? (Gates everything downstream.)
2. **Audience:** is AskWRI public, internal, or mixed? (Drives auth, ACL, ingestion roles.)
3. **Extraction:** how figure/table-heavy is the real corpus, and how bad is the broken-PDF tail? (Drives the document-understanding spike.)
4. **Lifecycle:** how do documents get updated/superseded in practice, and how should EN/ES versions of one report be treated?
5. **Eval resourcing:** who can produce multilingual golden sets and tagging labels, and on what budget?
6. **Org model:** do staff organize hierarchically (→ collections may need nesting)?
7. **Metadata shape:** which "new metadata types" are actually wanted — categorical only, or typed attributes/entities too?

## What this means for sequencing

Before freezing the Phase-0 schema, resolve governance (Q1) and run a **document-understanding spike** (Q3) on a representative sample. Those two can move the architecture; the rest can proceed in parallel with schema work. The dense-model bake-off should wait behind the governance answer.
