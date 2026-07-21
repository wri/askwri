# Sparse Retrieval Model Bake-off — Research Brief

**Date:** 2026-06-10  
**Status:** Open — decision not yet made  
**Workstream:** Retrieval / Document Management (Phase 1 gate before sparse swap)  
**Depends on:** `docs/plans/2026-06-09-askwri-document-management-design.md` §10, §11, §18; `docs/document-management.md` §8, §9

---

## 1. Decision to Make

**Which sparse representation replaces in-memory BM25 in the retrieval pipeline — and when is the cutover gated?**

Phase 1 ingestion ships against the existing BM25 lane. The `document_chunks.sparse` (`sparsevec`) column exists and is unpopulated. Populating it with a chosen model is a separate, eval-gated cutover. The design doc originally assumed BGE-M3 learned sparse for this column; that choice is **explicitly reopened** by the project owner: *"it's not clear that bge-m3 is the best choice and that needs more research and eval."*

Candidates include — and "keep BM25" is a legitimate outcome, not a strawman:

| Option | Class |
|---|---|
| Keep BM25 + per-language analyzers | Baseline A — current system, extended |
| Postgres FTS / `tsvector` + per-language configs + CJK strategy | Baseline B — SQL-native, no new serving |
| BGE-M3 sparse (`sparsevec`) | Learned sparse, original design assumption |
| SPLADE family (e.g., SPLADE-v3, EffSPLADE) | Learned sparse, alternative |
| "No learned sparse: dense + reranker only" (ablation) | Remove sparse lane entirely |

---

## 2. Why It Matters

### 2.1 Multilingual — CJK tokenization is the forcing function

BM25 (rank-bm25 via LlamaIndex) tokenizes on whitespace/punctuation. Chinese text has no word-boundary whitespace: a query "交通排放" over BM25 matches character n-grams at best, not semantic units. 19 of 169 documents are Chinese (`zh`), plus 2 Indonesian docs currently mislabeled as `en`. Spanish (10) and Portuguese (4) fare better under BM25 but still lack morphological normalization. Any sparse solution must have a credible CJK story.

### 2.2 Incremental indexing

In-memory BM25 requires a full `/reindex` call (or service restart) after any document change — withdrawal, addition, or update. This is already a documented operational gotcha (`docs/document-management.md` §4). A precomputed `sparsevec` written at ingest time is per-document and per-chunk: no global rebuild, consistent with the design's "incremental, not rebuild" principle (design §4).

### 2.3 Scale headroom

Corpus target is 1–5k documents. At 1k docs × ~10 chunks average = ~10k chunks, in-memory BM25 remains cheap. At 5k docs × 15 chunks = ~75k chunks, memory pressure and rebuild latency become real. The design gates this concern at ~10× growth but the sparse-swap decision should be forward-compatible.

### 2.4 Ranking sensitivity at the tail

Phase 0 parity results demonstrate that the current hybrid pipeline is **sensitive to sparse-lane tail changes**: even with bit-identical BM25 output and identical dense embeddings, residual divergence at the reranker logit floor produced chunk-adjacent F1 −2.4 (just past the ±2 gate), 2 rank-1 swaps (q7, q10 — same two documents, positions 1↔2), and top-20 overlap 0.940 vs. threshold 0.95 (`docs/plans/2026-06-09-phase0-store-and-migration-plan.md`, Task 10, Parity results). Swapping the sparse lane will move marginal documents across the reranker logit floor; the calibrated logit tiers (answer/cite modes) will need recalibration per candidate. This is not a reason to avoid the swap — it is a reason to measure carefully and coordinate with the retrieval workstream who own thresholds.

---

## 3. Candidates

**Knowledge-cutoff warning:** this brief reflects the landscape as of June 2026. The learned-sparse field moves fast. **Step 1 of the research is a fresh literature and leaderboard sweep** — C-MTEB ([https://huggingface.co/C-MTEB](https://huggingface.co/C-MTEB)), MTEB, and BEIR — not reliance on the snapshot below.

| Candidate | Multilingual story | `sparsevec` fit | Query-encode latency | Serving footprint | License | Maintenance risk |
|---|---|---|---|---|---|---|
| **BM25 + per-language analyzers** (baseline A) | Requires separate analyzer per language; CJK needs `jieba` or similar pre-tokenizer; no cross-lingual | N/A (in-memory, no `sparsevec`) | Negligible (token match) | Zero — already running | Apache-2.0 (rank-bm25) | Low — stable library |
| **Postgres FTS / `tsvector`** (baseline B) | Per-language config (`pg_catalog.chinese` is limited; `zhparser` extension not on RDS by default); CJK is the hard problem | Needs a `tsv tsvector` column added to `document_chunks` (the design listed it as optional; Phase 0 omitted it — small additive migration); query via `ts_rank`; no `sparsevec` | Negligible (SQL) | Zero — SQL-native | PostgreSQL license | Low — SQL-native, no model serving |
| **BGE-M3 sparse** | Trained on 100+ languages including zh/es/pt; produces token-weight dict from any language text; cross-lingual by design | Emits sparse weight dict → directly storable as `sparsevec`; pgvector `<#>` inner-product query | ~50ms p50 on CPU (design §10 budget); model is ~570MB | One always-warm CPU container (design §15); HNSW for `sparsevec` or exact scan at this corpus size | MIT ([https://huggingface.co/BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)) | Medium — BAAI-maintained; model versioning risk |
| **SPLADE family** (e.g., SPLADE-v3, EffSPLADE) | English-first training; multilingual variants exist but zh coverage is weaker than BGE-M3; verify on C-MTEB zh before shortlisting | Emits sparse logit activations → `sparsevec` compatible | ~30–80ms depending on variant; distilled variants faster | CPU-adequate at this scale; smaller than BGE-M3 | **License caveat: SPLADE-v2 is CC BY-NC-SA 4.0 (non-commercial). SPLADE-v3 and Naver SPLADE variants must be checked individually before use in a production WRI tool.** Check HF license card before any experiment. | Medium-high — Naver/non-commercial licensing creates adoption risk |
| **Dense + reranker only** (ablation) | Dense model handles multilingual if cross-lingual; reranker rescores | Remove sparse lane entirely; no `sparsevec` write | N/A | Removes BGE-M3 container | N/A | Low serving complexity; loses lexical-match recall |

### Notes on the "dense only" ablation

The current pipeline uses RRF k=60 fusing dense + BM25 lanes. BM25 provides lexical recall for exact-match queries (acronyms, proper nouns, technical terms) that dense models can miss. The ablation measures how much recall is lost when sparse is removed — it sets the floor for what any sparse replacement must beat.

---

## 4. Evaluation Methodology

### 4.1 Existing golden sets (mandatory floor)

Reuse without modification as the baseline comparison point:

| Set | Queries | Coverage |
|---|---|---|
| `evaluation/golden-dataset.json` | 11 cite queries, 74 expected docs | English-dominant corpus queries |
| `evaluation/answer-golden-dataset.json` | 9 answer cases, chunk-level labels | English-dominant |

Pass criteria (cite): recall ≥ 75%, precision ≥ 15%, F1 ≥ 25% per query. Each candidate must meet or exceed current BM25 baseline on these sets before advancing.

### 4.2 Required new asset: multilingual golden set

**This is the primary gap.** The existing golden sets do not exercise the zh/es/pt documents or non-English queries. The multilingual golden set must include:

- Minimum: 5–10 queries in Chinese (zh), 3–5 in Spanish (es), 2–3 in Portuguese (pt)
- Expected documents anchored to the actual zh/es/pt corpus (19 zh + 10 es + 4 pt docs)
- Cross-lingual queries (e.g., English query → zh/pt/es result expected)
- **Resourcing flag:** human labeling in four languages is required (design §16, §18.6). This is a people/time dependency — flag with the project owner before starting candidate experiments. LLM-assisted labeling is acceptable for bootstrapping but human review is required for the gate.

### 4.3 Metrics per candidate

| Metric | Measured how |
|---|---|
| Per-query P/R/F1 (cite) | `npm run eval:cite` against golden-dataset.json |
| Per-query P/R/F1 (answer, doc-level + chunk-adjacent) | `npm run eval:answer-retrieval` |
| Multilingual P/R/F1 | Same harness, multilingual golden set (§4.2) |
| Top-20 overlap vs. BM25 baseline | `compare_query_parity.py` pattern (phase0 script) |
| Rank-stability (rank-1 swaps, near-tie behavior) | compare_query_parity output |
| Query-encode latency p50/p95 | Local timing on representative hardware; target ≤50ms p50 (design §10) |
| Reranker logit-floor drift | Run Phase 0 parity script per candidate; flag queries where rank-1 swaps and marginal docs cross logit tiers — coordinate threshold recalibration with retrieval workstream |

### 4.4 Logit-floor coordination (critical)

The rerankers currently in production are `cross-encoder/ms-marco-MiniLM-L-6-v2` (cite) and `-L-12-v2` (answer) with calibrated logit thresholds; BGE-reranker-v2-m3 is the design's *future* multilingual reranker (separate workstream). Phase 0 showed that even identical document sets produce rank-1 swaps at near-tie logit scores. A different sparse lane will shift RRF fusion scores and likely shift which documents land near the logit floor. **Candidates must be evaluated against the current thresholds first; recalibration of thresholds is owned by the retrieval workstream and is out of scope of the sparse bake-off itself** (see §7), but the sparse team must flag drift to enable that work.

---

## 5. Test Harness Sketch

```
Candidate model
      │
      ▼
SparseProvider.sparse(texts) → weights dict   (design §11)
      │
      ▼
Stored as sparsevec in document_chunks.sparse
(per-collection via collections.embedding_model_version)
      │
      ▼
PgVector sparsevec retriever
      │
      ▼
RRF k=60 fusion with dense lane (text-embedding-3-small, unchanged)
      │
      ▼
Cross-encoder rerank (BGE-reranker-v2-m3, unchanged)
      │
      ▼
compare_query_parity.py  ←── side-by-side vs. BM25 baseline
      │
      ▼
eval:cite / eval:answer-retrieval
```

**Isolation:**

- Plug each candidate behind `SparseProvider` — no changes to dense lane, RRF weights, or reranker.
- A/B per collection via `collections.embedding_model_version` so candidates can coexist in the same Postgres instance without a schema change.
- The Phase 0 `compare_query_parity.py` pattern (side-by-side metric table + overlap score) is the standard output format; extend it for multilingual queries.
- BM25 baseline (current) is always present as the control arm.

**Serving for experiments:**

- BGE-M3 and SPLADE variants: run as a local Python process (same container pattern as the reranker). Use `FlagEmbedding` library for BGE-M3.
- BM25 extensions (jieba pre-tokenizer): modify `search-service/app/query_expansion.py` path or add a wrapper.
- Postgres FTS: SQL-only, no model serving needed.

---

## 6. Decision Criteria and Exit

### Priority order (explicit weights)

1. **Multilingual quality** — zh/es/pt recall on the multilingual golden set (§4.2). This is the forcing function; a candidate that fails CJK is disqualified regardless of English scores.
2. **English parity** — cite and answer P/R/F1 equal-or-better than BM25 baseline on existing golden sets.
3. **Ops simplicity** — does the candidate require new serving infrastructure, a new Postgres extension, or non-commercial license negotiation?
4. **Latency** — sparse query-encode ≤50ms p50 (design §10 budget; the reranker dominates latency, not sparse encode).

### "Good enough to switch" threshold

| Dimension | Threshold to advance |
|---|---|
| English cite F1 | ≥ current BM25 baseline (no regression) |
| English answer doc F1 | ≥ current BM25 baseline |
| Multilingual cite recall (zh) | ≥ 60% on the zh golden set (provisional; revise after human labels exist) |
| Sparse query-encode latency | ≤ 50ms p50 on CPU |
| License | Permissive commercial use (Apache-2.0 / MIT / BSD) |

### "Keep BM25" outcome

If no learned-sparse candidate meets the multilingual threshold **and** BM25 extended with a CJK pre-tokenizer (jieba) meets or exceeds the zh recall threshold at lower ops cost, retaining enhanced BM25 is the correct decision.

### Who decides

Project owner (reopened the BGE-M3 assumption) in consultation with the retrieval workstream lead. Decision requires: (a) multilingual golden set exists and has human review, (b) at least two candidates evaluated, (c) BM25 baseline established on multilingual set.

### Rough effort per candidate

| Candidate | Index effort | Eval effort | Serving effort |
|---|---|---|---|
| BM25 + jieba (CJK) | Low (modify tokenizer path) | 1–2 days (run harness) | None |
| Postgres FTS | Low–Medium (SQL configs, CJK extension research) | 1–2 days | None |
| BGE-M3 sparse | Medium (embed 169 docs × ~10 chunks; ~1h CPU cold) | 2–3 days | Small CPU container |
| SPLADE variant | Medium (same as BGE-M3; license check required first) | 2–3 days | Small CPU container |
| Dense-only ablation | Low (disable sparse lane) | 1 day | Simplifies serving |

Multilingual golden set creation: **2–5 days** depending on language resource availability — this is the long-pole dependency for all multilingual-quality measurements.

---

## 7. Out of Scope

| Topic | Where it lives |
|---|---|
| Dense embedding model bake-off (Voyage vs. Cohere vs. BGE-M3 dense) | Design §18.1, Phase 3. Related but separate; this brief holds dense constant at `text-embedding-3-small`. |
| Reranker model selection | Retrieval workstream. The current ms-marco MiniLM cross-encoders are held constant across all candidates in this bake-off. |
| Reranker threshold recalibration (logit floor/tiers) | Retrieval workstream owns. The sparse bake-off surfaces drift; recalibration is a separate task triggered after candidate selection. |
| RRF weight tuning (alpha / dense_weight / sparse_weight) | Retrieval workstream. Hold weights constant during candidate comparison. |
| Answer synthesis evaluation | Orthogonal to sparse retrieval choice. |

---

## Sources

Design doc §10, §11, §18, §21: `docs/plans/2026-06-09-askwri-document-management-design.md`  
As-built Phase 0: `docs/document-management.md`  
Phase 0 parity results: `docs/plans/2026-06-09-phase0-store-and-migration-plan.md` Task 10  
Eval harness: `evaluation/README.md`  
BGE-M3: [https://huggingface.co/BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) | [paper](https://arxiv.org/html/2402.03216v3)  
C-MTEB (Chinese leaderboard): [https://huggingface.co/C-MTEB](https://huggingface.co/C-MTEB)  
C-Pack / BGE Chinese: [https://arxiv.org/pdf/2309.07597](https://arxiv.org/pdf/2309.07597)  
pgvector sparsevec (RDS): [https://aws.amazon.com/about-aws/whats-new/2024/05/amazon-rds-postgresql-pgvector-0-7-0/](https://aws.amazon.com/about-aws/whats-new/2024/05/amazon-rds-postgresql-pgvector-0-7-0/)  
Voyage/OpenAI/Cohere/BGE comparison: [https://www.buildmvpfast.com/blog/best-embedding-model-comparison-voyage-openai-cohere-2026](https://www.buildmvpfast.com/blog/best-embedding-model-comparison-voyage-openai-cohere-2026)
