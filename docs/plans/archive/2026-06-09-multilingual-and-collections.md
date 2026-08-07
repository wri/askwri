# Multilingual Handling + Collections — Deep Dive

**Date:** 2026-06-09
**Status:** Draft for review
**Companion to:** `2026-06-09-document-management-redesign.md`
**Scope:** Language handling across the full processing/indexing/retrieval/synthesis pipeline, and the "collections" concept for admin management.

## The framing that matters

Language is not a model swap at the embedding step. It is a decision that touches **every stage** of the pipeline, and the wrong default at ingest is expensive to undo because it means re-processing the corpus. So the guiding principle for the doc-management feature is **capture-rich, decide-late**: at ingest we capture enough (native text, detected language, raw chunks, an English rendition of key fields) that we can change retrieval strategy *later without re-ingesting*. The feature's job is to make the best options *possible*, not to hard-commit to one now.

Below, "where language bites" at each stage, then the recommendation, then collections.

## Where language bites, stage by stage

**1. Text extraction / OCR.** Born-digital PDFs extract uniformly, but scanned documents need OCR that is script-aware — Latin, CJK, Arabic (right-to-left), Devanagari, and Cyrillic each need the right language pack and, for CJK/Thai, different segmentation. A pipeline tuned only for English silently produces garbage text for non-Latin scans, which then poisons everything downstream. *Implication:* detect script early; pick OCR config per document; flag low-confidence extractions for admin review.

**2. Language detection — at two levels.** Documents are not always monolingual (English abstract + Spanish body; quotations; bilingual reports). We need a **primary language** plus the **set of languages present**, detected at the *chunk* level, not just the document level, because lexical indexing and display decisions are per-chunk. *Implication:* store `language` on the document and on each chunk.

**3. Chunking.** Sentence and token segmentation are language-specific. Whitespace/word chunkers break on CJK and Thai (no word spaces); a fixed character count splits mid-grapheme in some scripts. *Implication:* use a tokenizer-aware chunker (the embedding model's own tokenizer is the safest choice — another reason the model decision propagates upstream).

**4. Title + summary generation.** Generate **both** a native-language summary and an English summary/title for every document, regardless of source language. The English rendition is cheap and pays for itself three times: consistent admin browsing of a multilingual corpus, a stable signal for reranking/synthesis, and a fallback for English-only filters. *Implication:* the LLM call must be told the source language; store `title`, `title_en`, `summary`, `summary_en`.

**5. Auto-tagging.** The controlled vocabulary must be **language-neutral**: canonical tag IDs with localized display labels, never free-text tags in mixed languages (or "transporte" and "transport" become different tags). The LLM maps any-language content onto canonical IDs. Geography extraction (NER) is itself language-specific. *Implication:* taxonomy = stable IDs + per-locale labels; classification is cross-lingual by design.

**6. Indexing — the dense side is easy, the sparse side is the trap.**
   - *Dense:* a multilingual embedder puts "transport" and "transporte" near each other in one vector space — cross-lingual retrieval falls out for free. Easy.
   - *Sparse / lexical:* this is where naive multilingual designs fail. BM25 and Postgres full-text search are **inherently per-language** — stemming, stopwords, and tokenization differ, and a single `simple` config throws away those gains; CJK needs n-gram tokenization entirely. The usual options are ugly: per-language `tsvector` columns with routing, or a language-agnostic n-gram index that retrieves worse.

**7. Retrieval.** Query-language detection; dense handles cross-lingual matching, but sparse only matches within-language unless you translate the query. Reranking is **mandatory and must be multilingual** — an English-only cross-encoder collapses on non-English and cross-lingual pairs. RRF fusion weights may need to lean more on dense for non-English queries.

**8. Synthesis + citation.** The answer should come back in the *query's* language even when supporting passages are in other languages, so the synthesis LLM translates on the fly and must cite correctly. Display the original-language snippet *and* a translation so users can verify.

## Recommendation: standardize on a unified multilingual model, capture-rich at ingest

**Primary recommendation: BGE-M3 as the embedding + sparse model, with a multilingual reranker (BGE-reranker-v2-m3).**

The decisive reason is stage 6. BGE-M3 is the first model to emit **dense vectors, multilingual-aware sparse lexical weights, and multi-vector (ColBERT) representations from a single pass**, across 100+ languages, up to 8,192 tokens, MIT-licensed and self-hostable ([HF](https://huggingface.co/BAAI/bge-m3), [paper](https://arxiv.org/html/2402.03216v3)). Its sparse component **dissolves the per-language Postgres-FTS problem** — we get multilingual lexical matching from the same model that produces the dense vectors, instead of maintaining N language-specific `tsvector` configs. That single property is worth more here than a couple of points of English-only retrieval quality.

**Treat the embedding model as a swappable provider, not a fixture.** BGE-M3 is today's strongest *candidate* for the reason above (unified dense+sparse kills the per-language FTS problem), but this space moves monthly and the model will likely change. The design must assume that. Concretely:
- **A provider interface**, not a hard dependency. Embedding + sparse + rerank sit behind a thin `RetrievalProvider` abstraction (`embed(texts) → vectors`, `sparse(texts) → weights`, `rerank(query, passages)`), so swapping BGE-M3 for Voyage, Cohere, Nomic, or whatever wins next is a config change plus a re-embed, not a rewrite. If the next model doesn't emit sparse weights, the interface falls back to Postgres FTS for the sparse lane — the consumer code doesn't change.
- **Dimension-agnostic storage.** Record `embedding_model` and `dimension` *per embedding row* (and per collection). `pgvector` supports differing vector widths across rows/tables, so a model swap means writing new embedding rows alongside the old, cutting over per collection, then dropping the old — never a destructive schema migration.
- **Re-embed, don't re-ingest.** Because native text + raw chunks are persisted, switching models replays only the embed step.

**Hosted vs. open is an open tradeoff — and the decisive insight is that the dense and sparse lanes can be decoupled.** On *dense* quality, hosted models lead: Voyage-3-large beats OpenAI text-embedding-3-large by ~9.7% and Cohere-English by ~20% across 100 datasets, and Cohere is the strongest commercial *cross-lingual* option ([Voyage](https://blog.voyageai.com/2025/01/07/voyage-3-large/), [comparison](https://www.buildmvpfast.com/blog/best-embedding-model-comparison-voyage-openai-cohere-2026)). But Chinese inverts the usual rule: Chinese-origin **open** models top the dedicated C-MTEB benchmark — BGE beat all prior Chinese embeddings by +10% on release, and Qwen3-Embedding / Conan-v2 now lead it ([C-MTEB](https://huggingface.co/C-MTEB), [C-Pack paper](https://arxiv.org/pdf/2309.07597)). So for the hardest language we're adding, "hosted is better" is weakest.

The catch with going hosted: **hosted embedders return only dense vectors, no sparse weights** — so choosing Voyage/Cohere reintroduces the per-language lexical problem, and reintroduces it worst for Chinese (CJK FTS needs jieba/n-gram tokenization). The provider interface resolves this cleanly by **splitting the lanes**:
- **Dense lane:** pluggable — a hosted model (Voyage/Cohere, likely best dense quality) *or* BGE-M3.
- **Sparse lane:** run BGE-M3 *purely for its lexical weights* (cheap, CPU-friendly), independent of the dense choice. This gives multilingual-aware sparse retrieval — including Chinese — without N language-specific `tsvector` configs, even when dense comes from a hosted API.

That decoupling means the dense-model decision can stay genuinely late and be made on evidence, while the sparse/CJK problem is solved once. The Phase-0 default can be "hosted dense + BGE-M3 sparse," with a straight BGE-M3-for-both option as the self-hosted fallback — both run behind the same interface.

Supporting choices:
- **Reranker:** a multilingual cross-encoder (BGE-reranker-v2-m3 today) — likewise behind the provider interface; cross-language pairs rerank ~5–10 nDCG points below same-language but remain usable, and truncate passages to <512 tokens ([guide](https://localaimaster.com/blog/reranking-cross-encoders-guide), [model](https://huggingface.co/dragonkue/bge-reranker-v2-m3-ko)).
- **Dimension:** depends on the chosen dense model (BGE-M3 1024-d; Voyage/Cohere differ) — the schema stores dimension per row precisely so this is not a commitment.
- **Languages to support first:** English, Spanish, **Chinese**, **Portuguese**. Chinese drives the CJK-specific work — OCR language packs, tokenizer-aware chunking, and the sparse-lane design below; it should anchor the evaluation golden set.

**Simplified vs. Traditional Chinese — index Simplified as canonical, normalize at ingest.** Modern academic and policy publishing from mainland China (CNKI and the major journals, and WRI's own Beijing-based China office) is overwhelmingly **Simplified**; Traditional is mostly Taiwan/Hong Kong and a much smaller share of the research literature. But this should not be an either/or: run **OpenCC** Traditional→Simplified normalization at ingest (and on the query), so a Traditional-script document or query still matches the Simplified index. That makes the distinction a non-issue for retrieval rather than a branch point — store the original text for display, index the normalized form. BGE-M3 handles both scripts, but normalizing keeps the *lexical/sparse* lane consistent, which is where script differences otherwise hurt.

### Sparse lane — the low-latency, no-quality-loss design

The goal you named (low latency, high performance, no quality loss, ideally staying in RDS) has a clean answer that keeps everything in Postgres:

- **Precompute at ingest, not at query time.** Document dense vectors *and* BGE-M3 learned-sparse weights are computed once per chunk during ingestion (a batch step — latency irrelevant) and stored in pgvector: dense as `vector`/`halfvec`, sparse as **`sparsevec`**. pgvector added `sparsevec` in 0.7.0 and RDS supports 0.8.0 today (PG 16.5+/15.9+/etc.), with improved planning for filtered queries — which matters because we filter by collection and language ([RDS pgvector 0.8.0](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-rds-for-postgresql-pgvector-080/), [0.7.0 / sparsevec](https://aws.amazon.com/about-aws/whats-new/2024/05/amazon-rds-postgresql-pgvector-0-7-0/)). `sparsevec` caps at 1,000 nonzero dims; sub-512-token chunks stay well under that (prune to top-weighted terms if ever needed).
- **Query time is one cheap encode + two index lookups.** Encoding a query with BGE-M3 is a **single ~50ms call on CPU** (≈20–30ms on GPU with batching) and produces the sparse query vector ([latency](https://huggingface.co/BAAI/bge-m3/discussions/9), [m3serve](https://github.com/MauroCE/m3serve)). Then: dense ANN (HNSW) + sparse inner-product search in Postgres → RRF fuse → multilingual rerank the top ~50 passages. **No second datastore, no per-language FTS.**
- **What actually dominates latency is the reranker, not sparse.** Budget there: keep the rerank set small and truncate passages <512 tokens. Run the encoder + reranker as one small always-warm service (CPU is adequate at this corpus size and likely QPS; move to a GPU container only if rerank throughput demands it).
- **This holds regardless of the dense-model choice.** If dense embeddings come from a hosted API (Voyage/Cohere), you still run BGE-M3 once per query purely for the sparse vector — the ~50ms is the whole cost of keeping a high-quality multilingual lexical lane. Learned sparse beats BM25 on multilingual/CJK, so this is a quality gain over Postgres FTS, not a compromise.

Net: **learned-sparse via `sparsevec` in the same RDS instance** is the best bet — it satisfies low latency (precompute + ~50ms query encode), preserves quality (learned sparse + multilingual rerank), and adds no infrastructure.
- **Query translation:** treat as an *optional booster* for sparse matching, not the core strategy. The literature is clear that translate-to-English pipelines are simple but lose information and miss documents that exist only in their original language ([cross-lingual RAG overview](https://www.emergentmind.com/topics/cross-lingual-retrieval-augmented-generation-rag), [Microsoft](https://medium.com/data-science-at-microsoft/building-and-evaluating-multilingual-rag-systems-943c290ab711)).

**The honest caveat, and why "decide-late" matters:** multilingual embedders vary *wildly* in quality across their supported languages, and most degrade on non-English vs. a dedicated English model; the consistent expert advice is "evaluate on your own corpus before committing" ([ZeroEntropy](https://zeroentropy.dev/articles/best-multilingual-embedding/), [Milvus](https://milvus.io/blog/choose-embedding-model-rag-2026.md)). So we do **not** hard-commit. Because ingest stores native text + raw chunks + English renditions, we can A/B BGE-M3 against managed options (Voyage `voyage-3-large`, Cohere `embed-v3`) on a multilingual golden set and switch the embedding model by re-embedding from stored text — no re-ingestion, no re-OCR, no re-tagging.

**What this means for the feature now:** the doc-management feature must, at ingest, persist: source file (S3), extracted native text, per-chunk language, raw chunks, native + English title/summary, and language-neutral tags. Given that, the retrieval strategy is a swappable layer on top. That is the whole point — support the best option without freezing it.

## Collections

Introducing **collections** is the right call, and it is a *different* concept from tags. Keeping them distinct prevents the mess where everything becomes a tag.

| | **Tags** | **Collections** |
|---|---|---|
| Nature | Descriptive facets (topic, sector, geography, language) | Curatorial containers |
| Origin | Mostly auto (LLM) + human correction | Human-defined, owned |
| Cardinality | Many tags per doc | A doc lives in one or more collections |
| Mental model | "What is this about?" | "Which managed set does this belong to?" |
| Primary use | Faceted filtering, classification | Management, scoping, permissions, bulk ops |

**Why collections help (the points you raised — find / manage / update):**
- *Find:* scope a query to one or more collections (e.g., "World Resources Report" only, or "LAC region office"). Cheaper and far more intuitive for admins than composing tag filters. Supports a default collection set per surface.
- *Manage:* ownership and (later) permissions attach to a collection, not 5,000 loose documents.
- *Update:* bulk operations run per collection — re-tag, re-embed, regenerate summaries, re-OCR, export, or delete a whole batch at once.

**Where collections and language intersect — this is the useful part:**
- A collection can carry a **language policy** and an **embedding-model version**. During the BGE-M3-vs-managed evaluation, a "candidate" collection can be embedded with a new model while the production corpus stays on the current one — clean A/B with no global migration.
- Collections make **incremental migration** safe: migrate the existing ~170 docs as collection `legacy-transport-decarb`, ingest new multilingual material into fresh collections, and cut retrieval over per collection as each is validated.
- Natural groupings emerge for free: by program (Transport Decarb, WRR), by office/region, by **language**, or by ingestion batch.

**Data model (extends the companion doc's schema):**
```
collections
  id (uuid, pk)
  name, slug, description
  owner, visibility            -- private | internal | public (permissions later)
  language_policy              -- e.g. {primary: 'en', index_native: true}
  embedding_model_version      -- enables per-collection A/B and staged migration
  created_at, updated_at

document_collections           -- many-to-many
  document_id (fk), collection_id (fk), added_by, added_at
```
Documents stay single source-of-record in `documents`; collections are overlapping views over them. Recommend **flat collections + tags for facets** rather than nested collection trees — nesting recreates the taxonomy problem that tags already solve.

## Admin UX implications

The self-serve UI (Phase 2 in the companion doc) gains a language-and-collections spine:
- **Language column + filter** on the document list; a per-document panel showing detected primary language, languages present, and the native/English title+summary side by side, with the English rendition editable.
- **Translation/extraction review queue** for low-confidence OCR or detection — the human-in-the-loop catch for non-Latin scans.
- **Collection management:** create/rename, assign documents (single + bulk), set language policy and model version, run bulk operations, export.
- **Tag review** stays as designed (accept/edit/reject LLM suggestions), now language-neutral.

## What we deliberately defer

We do *not* need to settle now: the final embedding model (evaluate BGE-M3 vs. managed on a real multilingual golden set), whether multi-vector/ColBERT reranking is worth the storage, per-collection permission granularity, or on-the-fly UI translation. The schema and ingest design above keep all of these open.

## Decision points for next session

1. **Languages confirmed:** English, Spanish, Chinese, Portuguese. Chinese handled as Simplified-canonical with OpenCC normalization at ingest (covers Traditional inputs without a separate index). Confirm whether French appears in the corpus.
2. **Dense-model bake-off:** Voyage-3-large vs. Cohere embed v4 vs. BGE-M3, scored on a Chinese+Spanish+Portuguese+English golden set — with the sparse lane held constant on BGE-M3 `sparsevec`. The one decision made on evidence, not now.
3. **Sparse lane:** resolved — BGE-M3 learned sparse, precomputed at ingest, stored as pgvector `sparsevec`, ~50ms query encode. Confirm RDS engine version is ≥ the pgvector 0.8.0 floor (PG 16.5+ etc.) or plan the minor-version bump.
4. Initial collections to define for the existing corpus and the first new multilingual batch.
5. Is query translation worth building as a Phase-3 sparse booster, or skip until eval shows a gap?

## Sources

Models / retrieval: [BGE-M3 (HF)](https://huggingface.co/BAAI/bge-m3), [BGE-M3 paper](https://arxiv.org/html/2402.03216v3), [BGE-reranker-v2-m3 guide](https://localaimaster.com/blog/reranking-cross-encoders-guide), [Best multilingual embeddings 2026 (ZeroEntropy)](https://zeroentropy.dev/articles/best-multilingual-embedding/), [Embedding model picks 2026 (Milvus)](https://milvus.io/blog/choose-embedding-model-rag-2026.md). Hosted vs. open + Chinese: [voyage-3-large](https://blog.voyageai.com/2025/01/07/voyage-3-large/), [Voyage/OpenAI/Cohere/BGE 2026 comparison](https://www.buildmvpfast.com/blog/best-embedding-model-comparison-voyage-openai-cohere-2026), [C-MTEB](https://huggingface.co/C-MTEB), [C-Pack / BGE Chinese paper](https://arxiv.org/pdf/2309.07597). Cross-lingual RAG practice: [Cross-lingual RAG overview](https://www.emergentmind.com/topics/cross-lingual-retrieval-augmented-generation-rag), [Building & evaluating multilingual RAG (Microsoft)](https://medium.com/data-science-at-microsoft/building-and-evaluating-multilingual-rag-systems-943c290ab711).
Local: `askwrimvp/search-service/data/documents.csv` (existing `languages` field), `askwrimvp/search-service/app/main.py` (current hybrid+rerank), `2026-06-09-document-management-redesign.md`.
