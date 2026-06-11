# Multilingual Retrieval — Design Research & Options

**Date:** 2026-06-10
**Status:** Research synthesis for design iteration (no decisions made here)
**Inputs:** full review of `search-service/`, Phase 0/1 plans, sparse bake-off brief; external research sweep (multilingual embeddings/sparse/OCR/rerankers; qmd; GraphRAG family; contextual retrieval; late interaction). Sources at end.
**Relates to:** design doc §10/§11/§18, `2026-06-10-sparse-model-bakeoff-brief.md` (extends, does not supersede)

---

## 1. Current pipeline — as verified in code

```
PDF → PDFReader (pypdf) → full_text + page_boundaries (char offsets)
    → SimpleNodeParser(chunk_size=400, overlap=80) + 1 summary node/doc
    → OpenAI text-embedding-3-small (1536d) → pgvector HNSW   [dense lane]
    → rank-bm25 in-memory, whitespace tokens, rebuilt at boot/POST /reindex   [sparse lane]
Query → static dictionary expansion (English-keyed, BM25 leg only)
    → dense top-500 ∥ BM25 top-500 → weighted RRF (k=60, 0.5/0.5)
    → cross-encoder rerank: ms-marco-MiniLM L-6 (cite) / L-12 (answer), ONNX CPU
    → cite: best-chunk-per-doc, logit floor −9.0, strong/partial/weak tiers
    → answer: page-1 demotion ×0.5, summary-node strip
    → passage context via document_texts.find(chunk[:100])
```

Corpus today: 169 docs — 19 zh, 10 es, 4 pt, 2 mislabeled id. English cite baseline: P 15.8% / R 78.4%.

### 1.1 Where this breaks for zh/es/pt (per stage)

| Stage | Failure | Severity |
|---|---|---|
| Extraction | pypdf on CJK: CID-encoded fonts without ToUnicode maps → garbled/unrecoverable text; no garble detection, silent fallback to summary-only | **High** — caps everything downstream |
| Chunking | `chunk_size=400` comment says "Characters" but SentenceSplitter chunk_size is **tokens** — verify; either way budget should be in embedding-model tokens (zh ≈ 1–2 tokens/char in cl100k). CJK sentence punctuation is handled by the default secondary regex, so splitting mostly works | Medium |
| Page attribution | `doc.text.find(node.text[:100])` heuristic; Phase 1 plans OpenCC t2s on **chunk text only** while `document_texts` keeps the original → `find()` fails for any doc containing traditional characters → wrong pages, "context match failed" passages | **High** — silent, zh-only |
| Dense | text-embedding-3-**small** is a generation behind on multilingual (3-large scores MIRACL 54.9 vs BGE-M3 67.8; small is weaker still); weak cross-lingual alignment | **High** |
| Sparse | whitespace BM25 cannot tokenize zh at all (known, forcing function of the bake-off brief); also rebuild-at-boot survives the Postgres cutover | **High** |
| Query expansion | static English-keyed dictionary; inert or harmful for zh/es/pt queries | Medium |
| Reranker | ms-marco MiniLM is **English-only**. zh pairs produce uncalibrated logits, and the cite floor (−9.0) + tiers were calibrated on English logits → mass silent drops of zh docs in cite mode | **Critical** — worse than no reranker |
| Eval | no multilingual golden set (acknowledged in bake-off brief §4.2) | Blocking for any decision |

Cross-cutting: nothing in the pipeline is cross-lingual today. An English query cannot reach a zh doc through any lane.

---

## 2. External research findings (condensed)

### 2.1 Dense embeddings (en/zh-Hans/es/pt + cross-lingual)

| Model | Multilingual quality | Dims | Hosting | License/cost |
|---|---|---|---|---|
| Qwen3-Embedding-0.6B/4B/8B | MMTEB #1-class at release (8B 70.58); zh first-class (CMTEB) | 32–4096 MRL | self-host (0.6B runs CPU) | Apache 2.0 |
| BGE-M3 | MMTEB dense ~59.6; MIRACL dense 67.8; trained explicitly for cross-lingual (MKQA); dense+sparse+ColBERT in one pass | 1024 | self-host, 568M | MIT |
| gemini-embedding-001 | 68.32 | 3072 (MRL) | API | **2,048-token input, silent truncation** — trap |
| Cohere embed-v4 | strong (vendor-published) | 1536 MRL | API (private AWS deploy available) | $0.12/M tok |
| voyage-3.5 | vendor claims best; not on MTEB | 1024 | API (MongoDB) | $0.06–0.18/M |
| OpenAI 3-large | MIRACL 54.9 — weakest serious option | 3072 | API | $0.13/M |

pgvector note: HNSW caps at 2,000 dims — 3072-dim models need MRL truncation or halfvec; BGE-M3 (1024) / Cohere (1536) fit natively. Schema already stores per-row `embedding_model`/`dimension`, so coexistence + per-collection cutover works as designed.

### 2.2 Sparse lane

- **SPLADE is English-only** (MS MARCO/BERT vocab) — disqualified for this corpus; also resolves the bake-off brief's license worry by irrelevance.
- **BGE-M3 lexical weights** are the only widely-deployed multilingual learned-sparse; directly storable in `sparsevec` (inner product `<#>`). Hard limits: sparsevec ≤16k nnz; **HNSW index ≤1,000 nnz/vector** — fine at 400-token chunks, but cap or prune for any long chunk (the per-doc summary nodes are safe; an 8k-token chunk is not).
- **Critical caveat:** M3 sparse does no term expansion/translation — it is **same-language-only**. Cross-lingual recall must come from dense + query translation + reranker. In RRF this degrades gracefully (sparse contributes within-language precision), but don't expect the sparse lane to fix en↔zh.
- BM25-in-Postgres alternatives on **RDS**: zhparser/pg_jieba/ParadeDB/VectorChord are **not on the RDS allowlist**. Only viable RDS paths: `pg_bigm` (bigram, supported) or app-side jieba feeding `'simple'` tsvectors (Python service already owns chunks). es/pt are trivial (`to_tsvector('spanish'|'portuguese')` + unaccent).

### 2.3 PDF extraction for zh

OmniDocBench (CVPR 2025; MinerU-lab-maintained, cross-check accordingly), Chinese edit distance (lower better): MinerU 0.215, PaddleOCR PP-StructureV3 ~0.206 (vendor), olmOCR <0.3 (7B VLM, GPU), marker mid (license: revenue-capped weights), **Docling 0.909 — not viable for zh**. Production pattern: fast path (PyMuPDF) for valid text layers + per-page **garble detection** (replacement-char ratio, expected-Unicode-block ratio, langID-vs-declared-language, chars/page vs ink) + OCR fallback for failing pages. PyMuPDF CJK is fine **when ToUnicode CMaps exist**; when absent the text layer is unrecoverable — OCR is the only fix.

### 2.4 Rerankers (multilingual)

| Model | Notes | License |
|---|---|---|
| **bge-reranker-v2-m3** | deploy-now choice: multilingual, ~1GB, CPU-feasible at small k, ONNX-able (fits current serving) | Apache 2.0 |
| Qwen3-Reranker-0.6B | best open quality esp. zh; causal-LM arch, heavier | Apache 2.0 |
| Cohere Rerank 3.5 | SOTA-class, no GPU to run; ~$2/1k searches, ~600ms RTT | API |
| jina-reranker-v2 | fast, good | CC-BY-NC (API for commercial) |

Whatever is chosen: **cite logit floor/tiers must be recalibrated per reranker and checked per language** (different models, different logit scales; same-language bias affects bi-encoders more than cross-encoders, which is why a multilingual reranker patches a lot of cross-lingual ranking error).

### 2.5 Cross-lingual strategy (what practitioners converge on)

Documented failure mode of "one multilingual space" alone: **same-language bias** — retrievers rank same-language docs above more-relevant other-language docs (arXiv 2507.07543, 2509.13930). The working pattern is hybrid:

1. multilingual dense space as backbone (index once, query in any language);
2. per-language lexical leg (M3-sparse or per-language FTS), same-language by nature;
3. **query translation when query language ≠ a covered corpus language** (cheap — queries are short; restores the lexical leg cross-lingually; glossary-control domain terms like official zh renderings of "NDC", "nature-based solutions");
4. **per-language balanced retrieval** — top-k per language (language column + filtered queries) fused in RRF, instead of one global top-k, to counter same-language bias;
5. multilingual reranker over the fused pool.

Translate-the-corpus-at-ingest (English pivot) is *not* recommended here: it breaks page-level provenance against the published PDF (the product's core contract) and bakes in MT errors. The design doc's native+English **summaries** (§7.5) already provide the English handle per doc without that cost.

WRI-specific note: some zh/es/pt docs are translations of English siblings — dedup/aliasing of translated siblings (design §7.6) matters more than perfect cross-lingual ranking for those pairs.

### 2.6 Patterns from qmd worth stealing (ranking policy, not infrastructure)

qmd (github.com/tobi/qmd, MIT) is a local hybrid-search CLI that encodes 2025-era consensus. Transferable to this stack:

- **Weighted RRF refinements:** original query counted ×2 vs expansion variants; **top-rank bonus** (+ε for any doc that was #1/#2–3 in any source list) — protects exact-match queries (report titles, indicator names) from expansion dilution. Hours of work in `HybridFusionRetriever`.
- **Position-aware retrieval/reranker blending** (RRF rank 1–3 → 75/25 retrieval/reranker; 4–10 → 60/40; 11+ → 40/60) — prevents the reranker from demoting high-confidence exact matches. Directly relevant given the logit-floor sensitivity documented in Phase 0 parity.
- **Typed, cached multi-query expansion** (`lex`/`vec`/`hyde` sub-queries from a small cheap model, all results RRF-fused) — replaces the static dictionary, and is where **query translation** naturally slots in as another typed sub-query. Cache by (query, language).
- **`--explain`-style score traces** (per-result per-stage breakdown) — feed the eval harness; matches the existing `return_intermediate_results` diagnostic.
- qmd's own docs flag its default embedder as weak on CJK and recommend Qwen3-Embedding-0.6B — consistent with §2.1.

### 2.7 GraphRAG family — assessed, mostly not applicable

- **GraphRAG/LightRAG/RAPTOR: skip.** Index-time LLM passes over the whole corpus (re-paid per language/model change), and community/tree summaries are synthetic artifacts that **break passage-level citation provenance** — a structural mismatch with cite mode. Their wins are on global/aggregative "themes across the corpus" questions, not who/what/where lookups.
- **LazyGraphRAG**: indexing is NLP-cheap, but its value (query-time budgeted LLM relevance assessment, claim extraction) can be adopted *without any graph* as a *citation-verification pass*: grade whether retrieved chunks support each citation (parallel cheap-LLM calls), one retry on weak support. Bounded cost, directly hardens the cite contract, measurable with `eval:cite`. Optional, later.
- **HippoRAG 2** (passage-node graph + PPR; retrieves real passages, so provenance survives) is the only graph approach worth revisiting — and only if evals later show a measured multi-hop failure class.
- **ColPali/ColQwen** (page-image late interaction): genuinely tempting for a figure/table-heavy corpus, and page-image citations are arguably better provenance for charts than OCR text. But: no MaxSim in pgvector (VectorChord is a different, non-RDS extension), GPU indexing/query, 100–500KB/page vectors. **Defer** until evals show "answer was in a figure the text pipeline missed" as a real failure class — the design doc's tables/figures-as-chunks (§7.3) is the right first attack on the same problem.
- **Contextual retrieval** (Anthropic): 50–100-token LLM-written situating context per chunk, prepended before dense+sparse indexing. −49% retrieval failures, −67% with reranking (Anthropic's numbers); ~$1/M doc tokens. **Adopt** — slots into the ingest worker with no schema change, and the context string (title, section, year, geography — in doc language + English) is also a cheap cross-lingual aid. Late chunking achieves similar goals but requires token-level embedding access (incompatible with API embedders) — skip.
- **Parent-document / small-to-big**: embed small chunks, return parent section for synthesis. Zero LLM cost; the schema already has `prev/next_chunk_id` and (Phase 1) section paths. Also the principled replacement for the brittle `get_passage_with_context` `find()` heuristic — store char offsets per chunk at ingest instead of re-finding text at query time. **Adopt.**

---

## 3. Design options

### D1. Extraction (zh forcing function)
- **(a) Recommended:** PyMuPDF fast path + per-page garble detection + OCR fallback (MinerU or PaddleOCR PP-StructureV3) for failing/scanned pages. Parse stage is already isolated (Phase 1 Task 5) — this is a provider swap as designed. Store per-chunk char offsets while we're in there (fixes §1.1 page attribution).
- (b) Minimal: PyMuPDF only + garble detection that routes failures to `needs_review` (quality gate §7.9). Defers OCR serving cost; zh scanned docs simply wait in review.
- (c) Hosted: LlamaParse for everything. Simplest ops, per-page cost, exit-risk.
- Anti-option: Docling for zh (benchmark-disqualified).

### D2. Dense embedding (the single biggest multilingual lever)
- **(a) Recommended bake-off shortlist:** BGE-M3 (MIT, 1024d, dense+sparse from one forward pass, designed for exactly this hybrid-in-pgvector shape) vs Qwen3-Embedding-0.6B (better dense, Apache, dense-only) vs Cohere embed-v4 (API-only, no serving). Hold the harness from the bake-off brief; extend it to dense.
- (b) Status quo (text-embedding-3-small) is not defensible for zh/es/pt — keep only as the control arm.
- Migration mechanics already designed: per-row model/dimension, per-collection `embedding_model_version` cutover, full corpus re-embed is small (~2k chunks today).

### D3. Sparse lane (extends the bake-off brief)
- **(a) Recommended:** BGE-M3 lexical weights → existing `sparsevec` (HNSW ≤1k nnz cap respected at current chunk sizes). Kills BM25 rebuild-at-boot as a side effect. If D2 picks BGE-M3 dense, sparse is free (same forward pass).
- (b) BM25 + app-side jieba pre-tokenization (zh) + Snowball stemming (es/pt) — lowest-tech, keeps in-memory rebuild problem, no cross-corpus consistency with sparsevec plan.
- (c) Postgres FTS per language + pg_bigm for zh (RDS-compatible, SQL-only) — viable baseline B from the brief; bigram precision is mediocre.
- (d) Dense-only ablation — still worth running to set the floor.
- New fact for the brief: SPLADE is **disqualified** (English-only), not merely license-risky.

### D4. Reranker + calibration (do not ship multilingual without this)
- **(a) Recommended:** bge-reranker-v2-m3, ONNX, same serving pattern as today. Recalibrate cite logit floor/tiers (they are model-specific), and validate tier behavior **per language** — same-language bias and per-language logit distributions are documented phenomena.
- (b) Cohere Rerank 3.5 API if avoiding model serving entirely; adds ~600ms + per-query cost.
- The current English MiniLM + English-calibrated floor on zh content is the most dangerous silent failure in the pipeline; this is a gate, not an optimization.

### D5. Query understanding + cross-lingual strategy
- **(a) Recommended:** replace the static dictionary with cached, typed LLM multi-query expansion (lex/vec, optional hyde), including **query translation into corpus languages with coverage** when detected query language differs; per-language balanced top-k; answer in query language (synthesis side, flagged to that workstream). fastText lid.176 + Unicode-script heuristics for query langID (treat as routing hint, never a gate — dense leg always runs over everything). Note Phase 1 picked `langdetect` for *document* langID — fine for long text; queries need the fastText+script path.
- (b) Minimal: multilingual dense + reranker only, no translation, accept same-language bias. Cheapest; measurably worse for en↔zh.

### D6. Retrieval policy upgrades (cheap, language-agnostic, from qmd/Anthropic)
- RRF: original-query ×2, top-rank bonus, position-aware reranker blending. Tune per-language fusion weights once the multilingual golden set exists.
- Contextual retrieval at ingest (worker stage, ~$1/M tokens).
- Parent-document expansion + stored chunk offsets (replaces `find()` heuristics for both page attribution and passage context — also fixes the OpenCC t2s mismatch bug, §1.1).
- Explain-trace in `/query` debug for the eval harness.

### D7. Defer (explicitly)
GraphRAG/LightRAG/RAPTOR; ColPali/VectorChord (revisit on measured figure/table failures); late chunking; full agentic loops; citation-verification pass (revisit after D1–D6 land — highest-value deferred item).

---

## 4. Sequencing logic (proposal to iterate on)

1. **Eval assets first** — multilingual golden set (zh 5–10, es 3–5, pt 2–3, + cross-lingual queries) is the long pole and gates D2/D3/D4. Start immediately (bake-off brief §4.2 resourcing flag stands).
2. **Bug fixes orthogonal to model choice** — chunk offsets + parent-doc context (kills two zh-breaking heuristics), token-vs-char chunk_size verification, langID of the 2 id docs.
3. **D4 reranker swap + recalibration** — prerequisite for trusting any multilingual eval numbers (current reranker corrupts them).
4. **D2+D3 combined bake-off** (dense × sparse candidates share one harness; BGE-M3 appears in both).
5. **D1 extraction hardening** — parallel track in the ingestion worker; zh docs can't be evaluated if their text is garbled, so garble detection lands early even if OCR fallback comes later.
6. **D5/D6 policy layer** — after the model substrate is chosen (RRF weight tuning is per-language and model-dependent).

Open questions for iteration:
- Self-host appetite: BGE-M3 + bge-reranker on one warm CPU container (design §15 already budgets this) vs API-only (Cohere embed+rerank)?
- Is per-language balanced top-k acceptable product behavior (cite results deliberately mixed-language), or should cite mode group/label by language?
- Query translation: LLM call per uncached query — latency budget OK in cite mode?
- Who labels the multilingual golden set (design §18.6 unresolved)?

---

## 5. Sources

Internal: `search-service/app/{main,indexing,config,pg_store,query_expansion}.py`, `docs/plans/2026-06-09-askwri-document-management-design.md`, `docs/plans/2026-06-10-phase1-ingestion-implementation-plan.md`, `docs/research/2026-06-10-sparse-model-bakeoff-brief.md`, `docs/research/2026-06-10-phase1-recon-notes.md`, `todo.md`.

External (key; full URL lists in the two research-agent reports of 2026-06-10):
Embeddings: Qwen3-Embedding (arXiv 2506.05176; HF), BGE-M3 (arXiv 2402.03216, ACL Findings 2024, MIT), MMTEB (arXiv 2502.13595), OpenAI embeddings announcement (MIRACL numbers), Gemini embedding docs (2,048-token limit), Cohere embed-v4 changelog, voyage-3.5 announcement (vendor-published).
Sparse/Postgres: pgvector README + issue #818 (sparsevec/HNSW nnz limits), MILCO (arXiv 2510.00671 — SPLADE English-only), RDS extension list (pg_bigm yes; zhparser/pg_jieba/ParadeDB no), VectorChord sparse/BM25 blogs, Postgres FTS dictionaries + unaccent.
Extraction: OmniDocBench (CVPR 2025), PaddleOCR 3.0 (arXiv 2507.05595), MinerU (arXiv 2409.18839; custom license), olmOCR, PyMuPDF issues #87/#4701/discussion #3801 (CJK/ToUnicode failures).
Cross-lingual: arXiv 2507.07543 (retriever is the cross-lingual bottleneck), arXiv 2509.13930 (linguistic nepotism), arXiv 2504.03616 (translation strategies), Elastic multilingual-search architecture, fastText lid.176 / fast-langdetect.
Rerankers: bge-reranker-v2-m3 (HF), Qwen3-Reranker (HF), Cohere Rerank 3.5 docs, jina-reranker-v2 (HF).
Patterns: qmd (github.com/tobi/qmd README/CHANGELOG), Anthropic contextual retrieval, LazyGraphRAG (MSR blog), HippoRAG 2 (arXiv 2502.14802), RAPTOR (arXiv 2401.18059), ColPali (arXiv 2407.01449), ColBERTv2/PLAID (arXiv 2112.01488), late chunking (arXiv 2409.04701).
