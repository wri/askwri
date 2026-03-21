# Retrieval Latency & Parameter Fixes

**Date:** 2026-03-21
**Status:** Draft
**Problem:** Cite mode takes 28s on QA Fargate. Multiple retrieval parameters are silently ignored. Retrieval presets are defined but unused, causing config drift.

## Context

### Measured latency breakdown (QA Fargate, 2 vCPU, 16GB)

| Stage | Cite mode | Answer mode |
|---|---|---|
| Stage 1 (embed + FAISS + BM25 + fusion) | ~1s | ~1s |
| Stage 2 (cross-encoder reranking) | ~27s | ~2s (20 candidates) |
| **Total** | **~28s** | **~3s** |

### Root cause

The cross-encoder reranker uses PyTorch on `python:3.12-slim` which lacks optimized BLAS (no MKL, no Accelerate). PyTorch falls back to unoptimized matrix math. The QA index has ~169 nodes after RRF deduplication (from a 203-doc corpus with ~2000 chunks — the actual fusion output depends on query overlap between dense and sparse results). Scoring these with L-6 takes ~27s on 2 vCPU vs ~0.5s on Mac Studio.

Note: The QA stage1_results count of 169 was measured on a specific query. The fusion_top_k=500 hardcoded limit means up to 500 candidates can reach the reranker depending on the query. The 27s is the measured worst case; the actual time scales with candidate count.

### Eval data: fusion_top_k sweep (11 cite golden queries, local)

| fusion_top_k | Avg Recall | Stage2 (rerank) | Total |
|---|---|---|---|
| 500 | 0.735 | 1.09s | 2.57s |
| 300 | 0.729 | 0.68s | 2.13s |
| **200** | **0.729** | **0.48s** | **1.91s** |
| 150 | 0.673 | 0.37s | 1.91s |
| 100 | 0.652 | 0.27s | 1.73s |

Sweet spot: **fusion_top_k=200** — 0.6% recall loss vs 500, 56% less reranking work. Top 6 docs identical across all values.

Note: answer mode already uses fusion_top_k=100 (hardcoded). This matches the proposed `ANSWER_PRESET.fusionTopK: 100` — no behavioral change for answer mode.

## Changes

### 1. ONNX reranker backend

Switch cross-encoder inference from PyTorch to ONNX Runtime. ONNX bundles optimized kernels independent of host BLAS.

**Custom reranker wrapper:** Subclass `BaseNodePostprocessor` from LlamaIndex. The wrapper:
- Loads `CrossEncoder(model, backend=settings.reranker_backend)` in `__init__`
- Implements `_postprocess_nodes(nodes, query_bundle)`: calls `model.predict()` on `(query, node.text)` pairs, assigns scores, sorts descending, returns top N
- No global state mutation — `top_n` is an instance field, not mutated per-request

When `reranker_backend="torch"`, fall back to the existing `SentenceTransformerRerank` (unchanged behavior for local dev where Mac Accelerate makes PyTorch faster).

**Files:**

| File | Change |
|---|---|
| `search-service/app/main.py` | Add `OnnxReranker(BaseNodePostprocessor)` class. In `load_documents_and_build_indexes()`, branch on `settings.reranker_backend`: "onnx" uses `OnnxReranker`, "torch" uses `SentenceTransformerRerank`. |
| `search-service/app/config.py` | Add `reranker_backend: str = "onnx"` (env var `RERANKER_BACKEND`) |
| `search-service/requirements.txt` | Add `onnxruntime`, `optimum[onnxruntime]` |
| `search-service/.env` (local) | Add `RERANKER_BACKEND=torch` for local dev |

**Runtime fallback:** If ONNX loading fails (e.g., missing dependency), log error and fall back to `SentenceTransformerRerank` rather than crashing the service.

**Estimated impact:** Cite mode reranking on QA: ~27s → ~2-5s.

### 2. Wire through ignored parameters

Two request parameters are accepted by Pydantic but not applied. One has a race condition.

**`bm25_top_k`:** The `BM25Retriever` is a singleton built at startup with `similarity_top_k=1000`. We cannot change this per-request without rebuilding the retriever. Fix: post-retrieval slice in `_retrieve()` — `sparse_results = self.bm25_retriever.retrieve(expanded_bundle)[:self.bm25_top_k]`. This limits candidates entering RRF fusion without rebuilding the index.

**`fusion_top_k`:** Currently hardcoded per-mode in `HybridFusionRetriever.__init__` (500 for cite, 100 for answer). The `request.fusion_top_k` field exists in `QueryRequest` (default 150) but was not passed through to the retriever. Fix: accept `fusion_top_k` param in constructor, remove hardcoded values, pass from `hybrid_query()`.

**Reranker `top_n` race condition:** The current code mutates the global reranker's `top_n` per-request with save/restore (lines 1141-1147). Not thread-safe with `workers > 1`. Fix: the custom `OnnxReranker` wrapper accepts `top_n` as a parameter to `_postprocess_nodes()`, avoiding global mutation. For the torch fallback, slice output after calling `postprocess_nodes()` instead of mutating `base_reranker.top_n`.

**Files:**

| File | Change |
|---|---|
| `search-service/app/main.py` | `HybridFusionRetriever.__init__`: accept `fusion_top_k` and `bm25_top_k` params, remove hardcoded per-mode values. |
| `search-service/app/main.py` | `HybridFusionRetriever._retrieve()`: slice BM25 results to `self.bm25_top_k` before fusion. |
| `search-service/app/main.py` | `hybrid_query()`: pass `fusion_top_k` and `bm25_top_k` from request to retriever. |
| `search-service/app/main.py` | Reranker: `OnnxReranker` takes `top_n` per-call. Torch fallback slices output instead of mutating global. |

### 3. Single source of truth for retrieval params

**Problem:** `CITE_PRESET` is defined in `retrieval.ts` but never imported. `route.ts` hardcodes different values inline. `AIResearchModal.tsx` hardcodes `alpha: 0.5` for answer mode, overriding the sweep-validated 0.65 default in `ANSWER_PRESET`.

**Key bug being fixed:** The modal sends `alpha: 0.5` which `route.ts` maps to `dense_weight: 0.5, sparse_weight: 0.5`. This overrides the `ANSWER_PRESET.alpha: 0.65` that was validated by the precision sweep (P@8: 0.611 → 0.639). After this fix, answer mode will use the correct 0.65/0.35 weighting.

**Parameter changes (cite mode):**

| Parameter | Current (route.ts hardcoded) | After (CITE_PRESET) | Notes |
|---|---|---|---|
| `denseTopK` | 800 | 500 | 203-doc corpus doesn't need 800 |
| `sparseTopK` | 800 | 500 | Same |
| `rerankTopN` | 250 | 200 | Output cap; doesn't affect scoring work |
| `fusionTopK` | not sent (Python default 500) | 200 | Main latency lever; eval shows 0.6% recall loss |
| `alpha` | not sent (Python default 0.5) | 0.5 | No change |

**Files:**

| File | Change |
|---|---|
| `src/config/retrieval.ts` | Add `fusionTopK` to `RetrievalParams` type. Update `CITE_PRESET`: `denseTopK: 500`, `sparseTopK: 500`, `rerankTopN: 200`, `fusionTopK: 200`. Update `ANSWER_PRESET`: add `fusionTopK: 100`. |
| `src/app/api/llamaindex/route.ts` | Import `CITE_PRESET`. Replace hardcoded cite defaults with preset values. Add `fusion_top_k` to both cite and answer request payloads. Update `LlamaIndexRequest` interface to include `fusion_top_k`. |
| `src/app/components/AnswerMode/AIResearchModal.tsx` | Remove all retrieval params (`alpha`, `denseTopK`, `sparseTopK`, `rerankTopK`, `retrievalMode`, `similarity_threshold`, `rerank`). Send only `query`, `mode`, `cite_doc_ids`, `include_metadata`. |
| `search-service/app/main.py` | Fix debug output to report actual `request.fusion_top_k` instead of hardcoded value. |

### 4. Synthesis prompt bug & Dockerfile

**Files:**

| File | Change |
|---|---|
| `src/app/api/answer/route.ts` | Line 392: replace `docList` with `filteredDocs` in synthesis prompt builder. Currently moot (nano filter gated off) but should be correct for when re-enabled. |
| `search-service/Dockerfile` | Add `RUN` step after pip install but before `USER appuser`. Set `HF_HOME=/opt/models` so cache location is consistent between build and runtime. Pre-download both models with ONNX export. |

```dockerfile
ENV HF_HOME=/opt/models

# Pre-download reranker models + ONNX exports (eliminates runtime HF download)
RUN python -c "from sentence_transformers import CrossEncoder; \
    CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2', backend='onnx'); \
    CrossEncoder('cross-encoder/ms-marco-MiniLM-L-12-v2', backend='onnx')"

# Make models readable by appuser
RUN chmod -R a+r /opt/models
```

Note: the cite reranker model (`cross-encoder/ms-marco-MiniLM-L-6-v2`) is hardcoded in `main.py` line 923, not configurable via `config.py`. The answer reranker model is configurable via `answer_reranker_model`. This asymmetry is acceptable for now — both models are baked into the Docker image regardless.

## Expected outcome

| Metric | Before | After |
|---|---|---|
| Cite mode latency (QA) | ~28s | ~4-8s |
| Answer mode latency (QA) | ~3s | ~2-3s |
| Cite recall (golden set) | 0.735 | 0.729 |
| Answer mode alpha | 0.5 (modal override) | 0.65 (sweep-validated) |
| Cold start model download | 860MB from HuggingFace | 0 (baked into image) |
| Ignored parameters | 2 (bm25_top_k, fusion_top_k) | 0 |
| Reranker race condition | Mutable global top_n | Per-call top_n / sliced output |
| Config drift | CITE_PRESET unused, modal overrides alpha | Single source of truth |

## Risks

- **ONNX score parity:** Verified locally — max score diff 0.000355 between PyTorch and ONNX. Negligible.
- **ONNX runtime failure:** If ONNX fails to load, fallback to SentenceTransformerRerank (torch). Logged as warning.
- **Docker image size:** Adding ONNX models increases image by ~860MB. Acceptable tradeoff for eliminating runtime downloads. Actual ONNX export sizes may differ slightly from PyTorch model sizes.
- **fusion_top_k=200 recall:** 0.6% lower than 500 on golden set. Top 6 docs identical. Acceptable.
- **Removing modal params:** If route.ts preset values are wrong, all answer queries break. Mitigated by preset values matching current production behavior (except alpha fix from 0.5→0.65, which is intentional).
- **cite denseTopK 800→500:** Reduces vector retrieval pool. With 203 docs / ~2000 chunks, 500 is still ample coverage (~25% of corpus).
