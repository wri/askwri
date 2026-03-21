# Retrieval Latency & Parameter Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut cite mode latency from 28s to ~4-8s on QA Fargate and fix ignored/drifted retrieval parameters.

**Architecture:** Switch cross-encoder rerankers from PyTorch to ONNX Runtime for 5-10x inference speedup on CPU. Wire through ignored `bm25_top_k` and `fusion_top_k` params. Consolidate retrieval config into presets (`CITE_PRESET`/`ANSWER_PRESET`) as single source of truth, removing hardcoded overrides from route.ts and the answer modal.

**Tech Stack:** Python/FastAPI (search service), ONNX Runtime, sentence-transformers CrossEncoder, Next.js (API routes), TypeScript (frontend)

**Spec:** `docs/superpowers/specs/2026-03-21-retrieval-latency-param-fixes-design.md`

---

### Task 1: Add ONNX dependencies and config

**Files:**
- Modify: `search-service/requirements.txt`
- Modify: `search-service/app/config.py`
- Modify: `search-service/.env`

- [ ] **Step 1: Add ONNX packages to requirements.txt**

Add after the `sentence-transformers` line:

```
# ONNX Runtime for fast cross-encoder inference on CPU (Fargate)
onnxruntime>=1.17.0
optimum[onnxruntime]>=1.17.0
```

Also update the `sentence-transformers` version constraint (backend= kwarg requires v3+):

```
sentence-transformers>=3.0.0
```

- [ ] **Step 2: Add reranker_backend setting to config.py**

Add after the `answer_reranker_model` line in the `Settings` class:

```python
    # Reranker inference backend: "onnx" for Fargate (fast CPU), "torch" for local dev (Mac Accelerate)
    reranker_backend: str = "onnx"
```

- [ ] **Step 3: Add RERANKER_BACKEND=torch to local .env**

Append to `search-service/.env`:

```
# Use PyTorch backend locally (Mac Accelerate is faster than ONNX on Apple Silicon)
RERANKER_BACKEND=torch
```

- [ ] **Step 4: Commit**

```
git add search-service/requirements.txt search-service/app/config.py search-service/.env
git commit -m "deps: add ONNX runtime and reranker backend config"
```

---

### Task 2: Implement OnnxReranker wrapper

**Files:**
- Modify: `search-service/app/main.py:177-260` (add class before HybridFusionRetriever)

- [ ] **Step 1: Add OnnxReranker class**

Insert after the `QueryResponse` class (around line 176) and before `HybridFusionRetriever`:

```python
from llama_index.core.postprocessor.types import BaseNodePostprocessor

class OnnxReranker(BaseNodePostprocessor):
    """Cross-encoder reranker using ONNX or PyTorch backend via sentence-transformers.

    Subclasses BaseNodePostprocessor for LlamaIndex compatibility.
    Unlike SentenceTransformerRerank, this does not mutate global state per-request.
    top_n is passed per-call to avoid race conditions with concurrent requests.
    """

    model_name: str = ""
    top_n: int = 20
    _cross_encoder: Any = None

    def __init__(self, model: str, top_n: int = 20, backend: str = "onnx", **kwargs):
        super().__init__(**kwargs)
        from sentence_transformers import CrossEncoder
        self.top_n = top_n
        self.model_name = model
        try:
            self._cross_encoder = CrossEncoder(model, backend=backend)
            logger.info(f"Loaded reranker {model} with {backend} backend")
        except Exception as e:
            logger.warning(f"Failed to load {backend} backend for {model}: {e}. Falling back to torch.")
            self._cross_encoder = CrossEncoder(model, backend="torch")

    def _postprocess_nodes(self, nodes, query_bundle=None):
        """Score and rerank nodes."""
        if not nodes or query_bundle is None:
            return nodes

        query = query_bundle.query_str
        pairs = [[query, node.node.get_content()] for node in nodes]

        scores = self._cross_encoder.predict(pairs)

        for node, score in zip(nodes, scores):
            node.score = float(score)

        nodes.sort(key=lambda n: n.score, reverse=True)
        return nodes[:self.top_n]

    def postprocess_nodes(self, nodes, query_bundle=None, top_n=None):
        """Public method with per-call top_n override."""
        if not nodes:
            return []

        saved_top_n = self.top_n
        if top_n is not None:
            self.top_n = top_n
        result = self._postprocess_nodes(nodes, query_bundle)
        self.top_n = saved_top_n
        return result
```

Note: The `_cross_encoder` field uses `Any` type annotation (already imported at the top of main.py) since Pydantic's `BaseModel` (which `BaseNodePostprocessor` inherits from) requires declared fields. The `_` prefix makes it a private attribute that Pydantic won't try to validate.

- [ ] **Step 2: Verify the service starts locally**

Run: `cd search-service && RERANKER_BACKEND=torch python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000`

Expected: Service starts without import errors. The OnnxReranker class is defined but not yet used.

- [ ] **Step 3: Commit**

```
git add search-service/app/main.py
git commit -m "feat: add OnnxReranker wrapper with per-call top_n and fallback"
```

---

### Task 3: Wire OnnxReranker into reranker loading

**Files:**
- Modify: `search-service/app/main.py:909-936` (reranker loading in `load_documents_and_build_indexes`)
- Modify: `search-service/app/main.py:1129-1154` (reranker usage in `hybrid_query`)

- [ ] **Step 1: Update reranker loading to branch on backend setting**

Replace the reranker loading block (lines ~909-936) with:

```python
    # Initialize rerankers
    logger.info(f"🔄 Loading cross-encoder rerankers (backend: {settings.reranker_backend})...")
    step_start = time.time()

    answer_reranker_model = settings.answer_reranker_model
    cite_reranker_model = "cross-encoder/ms-marco-MiniLM-L-6-v2"

    if settings.reranker_backend == "onnx":
        logger.info(f"   [1/2] Loading Answer mode reranker ({answer_reranker_model}, ONNX)...")
        reranker_start = time.time()
        reranker_answer = OnnxReranker(model=answer_reranker_model, top_n=20, backend="onnx")
        logger.info(f"   ✓ Answer reranker loaded in {time.time() - reranker_start:.1f}s")

        logger.info(f"   [2/2] Loading Cite mode reranker ({cite_reranker_model}, ONNX)...")
        reranker_start = time.time()
        reranker_cite = OnnxReranker(model=cite_reranker_model, top_n=200, backend="onnx")
        logger.info(f"   ✓ Cite reranker loaded in {time.time() - reranker_start:.1f}s")
    else:
        logger.info(f"   [1/2] Loading Answer mode reranker ({answer_reranker_model}, torch)...")
        reranker_start = time.time()
        reranker_answer = SentenceTransformerRerank(model=answer_reranker_model, top_n=20)
        logger.info(f"   ✓ Answer reranker loaded in {time.time() - reranker_start:.1f}s")

        logger.info(f"   [2/2] Loading Cite mode reranker ({cite_reranker_model}, torch)...")
        reranker_start = time.time()
        reranker_cite = SentenceTransformerRerank(model=cite_reranker_model, top_n=200)
        logger.info(f"   ✓ Cite reranker loaded in {time.time() - reranker_start:.1f}s")

    logger.info(f"✅ All rerankers loaded in {time.time() - step_start:.1f}s")
```

- [ ] **Step 2: Fix reranker usage in hybrid_query to eliminate race condition**

Replace the reranker block (lines ~1129-1154) with:

```python
        # Stage 2: Local Reranking
        if request.rerank and stage1_results:
            base_reranker = (service_state["reranker_answer"] if request.mode == "answer"
                            else service_state["reranker_cite"])

            if base_reranker:
                try:
                    stage2_start = time.time()
                    if isinstance(base_reranker, OnnxReranker):
                        # OnnxReranker: pass top_n per-call (no global mutation)
                        stage2_results = base_reranker.postprocess_nodes(
                            stage1_results, query_bundle, top_n=request.rerank_top_n
                        )
                    else:
                        # SentenceTransformerRerank: call with default top_n, then slice
                        stage2_results = base_reranker.postprocess_nodes(
                            stage1_results, query_bundle
                        )
                        stage2_results = stage2_results[:request.rerank_top_n]
                    stage2_elapsed = time.time() - stage2_start
                    logger.info(f"Stage 2 (Reranking): {len(stage2_results)} results from {len(stage1_results)} candidates in {stage2_elapsed:.1f}s")
                except Exception as e:
                    logger.warning(f"Reranking failed: {e}, using Stage 1 results")
                    stage2_results = stage1_results
            else:
                stage2_results = stage1_results
        else:
            stage2_results = stage1_results
```

- [ ] **Step 3: Test locally with torch backend**

Run: `cd search-service && RERANKER_BACKEND=torch python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000`

Wait for "healthy" then test:

```
curl -s -X POST http://localhost:8000/query \
  -H "Content-Type: application/json" \
  -d '{"query":"How to build more equal cities","mode":"cite","rerank":true}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Results: {d[\"total_results\"]}, Stage2: {d[\"debug\"][\"stage2_results\"]}')"
```

Expected: Results returned, no errors.

- [ ] **Step 4: Commit**

```
git add search-service/app/main.py
git commit -m "feat: wire OnnxReranker into service with torch fallback and race-condition fix"
```

---

### Task 4: Wire through fusion_top_k and bm25_top_k

**Files:**
- Modify: `search-service/app/main.py:177-260` (HybridFusionRetriever)
- Modify: `search-service/app/main.py:1101-1115` (hybrid_query retriever construction)
- Modify: `search-service/app/main.py:1325-1330` (debug output)

- [ ] **Step 1: Update HybridFusionRetriever to accept fusion_top_k and bm25_top_k**

Replace the `__init__` method:

```python
    def __init__(
        self,
        vector_retriever: VectorIndexRetriever,
        bm25_retriever: BM25Retriever,
        mode: str = "cite",
        similarity_threshold: float = 0.0,
        dense_weight: Optional[float] = None,
        sparse_weight: Optional[float] = None,
        fusion_top_k: Optional[int] = None,
        bm25_top_k: Optional[int] = None,
        **kwargs
    ):
        super().__init__(**kwargs)
        self.vector_retriever = vector_retriever
        self.bm25_retriever = bm25_retriever
        self.mode = mode
        self.similarity_threshold = similarity_threshold
        self.bm25_top_k = bm25_top_k

        # Weights default to 0.5/0.5 if not specified by caller
        self.dense_weight = dense_weight if dense_weight is not None else 0.5
        self.sparse_weight = sparse_weight if sparse_weight is not None else 0.5

        # fusion_top_k: caller controls via preset; fall back to mode defaults
        if fusion_top_k is not None:
            self.fusion_top_k = fusion_top_k
        elif mode == "answer":
            self.fusion_top_k = 100
        else:
            self.fusion_top_k = 500
```

- [ ] **Step 2: Slice BM25 results in _retrieve()**

In the `_retrieve` method, after `sparse_results = self.bm25_retriever.retrieve(expanded_bundle)`, add:

```python
        # Slice BM25 results to requested top_k (BM25Retriever is a singleton built
        # at startup with similarity_top_k=1000; per-request limit applied here)
        if self.bm25_top_k is not None:
            sparse_results = sparse_results[:self.bm25_top_k]
```

- [ ] **Step 3: Pass fusion_top_k and bm25_top_k in hybrid_query()**

Update the `HybridFusionRetriever` construction in `hybrid_query()`:

```python
        hybrid_retriever = HybridFusionRetriever(
            vector_retriever=vector_retriever,
            bm25_retriever=service_state["bm25_retriever"],
            mode=request.mode,
            similarity_threshold=request.similarity_threshold,
            dense_weight=request.dense_weight,
            sparse_weight=request.sparse_weight,
            fusion_top_k=request.fusion_top_k,
            bm25_top_k=request.bm25_top_k,
        )
```

- [ ] **Step 4: Fix debug output**

Replace the stale hardcoded `fusion_top_k` in the debug dict:

```python
                "mode_config": {
                    "dense_weight": request.dense_weight,
                    "sparse_weight": request.sparse_weight,
                    "fusion_top_k": request.fusion_top_k,
                    "cite_filtering": "minimal" if request.mode == "cite" else "threshold_based"
                }
```

- [ ] **Step 5: Test locally — verify fusion_top_k is respected**

```
curl -s -X POST http://localhost:8000/query \
  -H "Content-Type: application/json" \
  -d '{"query":"How to build more equal cities","mode":"cite","fusion_top_k":200,"rerank":true}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Stage1: {d[\"debug\"][\"stage1_results\"]}, fusion_top_k: {d[\"debug\"][\"mode_config\"][\"fusion_top_k\"]}')"
```

Expected: `Stage1: 200, fusion_top_k: 200`

- [ ] **Step 6: Commit**

```
git add search-service/app/main.py
git commit -m "fix: wire through fusion_top_k and bm25_top_k params, fix debug output"
```

---

### Task 5: Update retrieval presets and route.ts

**Files:**
- Modify: `src/config/retrieval.ts`
- Modify: `src/app/api/llamaindex/route.ts`

- [ ] **Step 1: Add fusionTopK to RetrievalParams type and update presets**

Replace the entire file `src/config/retrieval.ts`:

```typescript
export type RetrievalParams = {
  retrievalMode?: "chunks" | "docs" | "hybrid";
  denseTopK?: number;
  sparseTopK?: number;
  alpha?: number;
  rerank?: boolean;
  rerankTopN?: number;
  maxResults?: number;
  fusionTopK?: number;
};

export const ANSWER_PRESET: RetrievalParams = {
  retrievalMode: "hybrid",
  denseTopK: 150,
  sparseTopK: 150,
  alpha: 0.65,        // Favor semantic search — sweep showed P@8 improves 0.611→0.639
  rerank: true,
  rerankTopN: 20,     // Sweep showed no P@8 gain from reranking more candidates
  maxResults: 15,     // Return top 15 (down from 20) — tighter precision
  fusionTopK: 100,    // RRF fusion limit for answer mode
};

export const CITE_PRESET: RetrievalParams = {
  retrievalMode: "hybrid",
  denseTopK: 500,     // 203-doc corpus — 500 is ample coverage
  sparseTopK: 500,
  alpha: 0.5,         // Balanced dense/sparse fusion
  rerank: true,
  rerankTopN: 200,    // Output cap after reranking
  maxResults: 100,    // Return up to 100 docs (filtered by logit floor)
  fusionTopK: 200,    // RRF fusion limit — eval shows 0.6% recall loss vs 500, 56% less rerank work
};
```

- [ ] **Step 2: Update route.ts to use CITE_PRESET and send fusion_top_k**

In `src/app/api/llamaindex/route.ts`:

Add `CITE_PRESET` to the import:

```typescript
import { ANSWER_PRESET, CITE_PRESET } from '@/config/retrieval'
```

Replace the `defaults` block (lines 68-83):

```typescript
    const defaults =
      mode === 'cite'
        ? {
            max_results: CITE_PRESET.maxResults,
            vector_top_k: CITE_PRESET.denseTopK,
            bm25_top_k: CITE_PRESET.sparseTopK,
            rerank_top_n: CITE_PRESET.rerankTopN,
            fusion_top_k: CITE_PRESET.fusionTopK,
          }
        : {
            max_results: ANSWER_PRESET.maxResults,
            vector_top_k: ANSWER_PRESET.denseTopK,
            bm25_top_k: ANSWER_PRESET.sparseTopK,
            rerank_top_n: ANSWER_PRESET.rerankTopN,
            fusion_top_k: ANSWER_PRESET.fusionTopK,
            dense_weight: ANSWER_PRESET.alpha,
            sparse_weight: 1 - (ANSWER_PRESET.alpha ?? 0.5),
          }
```

Add `fusion_top_k` to the `LlamaIndexRequest` interface:

```typescript
interface LlamaIndexRequest {
  query: string
  mode: 'answer' | 'cite'
  max_results?: number
  similarity_threshold?: number
  include_metadata?: boolean
  rerank?: boolean
  cite_doc_ids?: string[]
  alpha?: number
  denseTopK?: number
  sparseTopK?: number
  rerankTopK?: number
  fusionTopK?: number
  retrievalMode?: 'chunks' | 'docs' | 'hybrid'
}
```

Also update the type annotation on `llamaIndexRequest` (line 85-88) to include `fusion_top_k`:

```typescript
    const llamaIndexRequest: LlamaIndexRequest & {
      vector_top_k?: number
      bm25_top_k?: number
      rerank_top_n?: number
      fusion_top_k?: number
    } = {
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`

Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```
git add src/config/retrieval.ts src/app/api/llamaindex/route.ts
git commit -m "feat: use CITE_PRESET in route, add fusion_top_k to both modes"
```

---

### Task 6: Strip retrieval params from AIResearchModal

**Files:**
- Modify: `src/app/components/AnswerMode/AIResearchModal.tsx:104-121`

- [ ] **Step 1: Remove hardcoded retrieval params from modal fetch**

Replace the fetch body (lines 107-120):

```typescript
        body: JSON.stringify({
          query: query.trim(),
          mode: 'answer',
          include_metadata: true,
          ...(consultedDocIds ? { cite_doc_ids: consultedDocIds } : {}),
        }),
```

This removes `alpha: 0.5`, `denseTopK`, `sparseTopK`, `rerankTopK`, `retrievalMode`, `similarity_threshold`, `rerank`, and `max_results`. Route.ts defaults from `ANSWER_PRESET` handle all of these. The key fix: `alpha: 0.5` no longer overrides the sweep-validated 0.65.

- [ ] **Step 2: Verify build passes**

Run: `npm run build`

Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```
git add src/app/components/AnswerMode/AIResearchModal.tsx
git commit -m "fix: remove hardcoded retrieval params from modal — use ANSWER_PRESET defaults

The modal was sending alpha=0.5, overriding the sweep-validated 0.65
default in ANSWER_PRESET. Route.ts now controls all retrieval params."
```

---

### Task 7: Fix synthesis prompt to use filteredDocs

**Files:**
- Modify: `src/app/api/answer/route.ts:392`

- [ ] **Step 1: Replace docList with filteredDocs in synthesis prompt**

In `src/app/api/answer/route.ts`, change line 392 from `${docList` to `${filteredDocs`:

```typescript
    const userContent = `Question: ${query}

Source documents with key findings:
${filteredDocs
  .map(
    (d) =>
      `[${d.id}] "${d.title}" (${d.year || 'n.d.'})
   Key finding: ${d.key_finding}`,
  )
  .join('\n\n')}

Task: Evaluate each source's relevance, then write exactly 2-3 clear sentences synthesizing the most important information from the relevant sources. Focus on breadth - touch on multiple key findings rather than elaborating on one.`
```

Note: Currently moot since nano filter is gated off (`USE_NANO_FILTER=false`), but makes the code correct for when it's re-enabled.

- [ ] **Step 2: Commit**

```
git add src/app/api/answer/route.ts
git commit -m "fix: synthesis prompt uses filteredDocs instead of docList"
```

---

### Task 8: Pre-download models in Dockerfile

**Files:**
- Modify: `search-service/Dockerfile`

- [ ] **Step 1: Add model pre-download step to Dockerfile**

After the `RUN pip install` line (line 30) and before the production stage, add:

```dockerfile
# Pre-download reranker models + ONNX exports (eliminates ~860MB runtime HF download)
ENV HF_HOME=/opt/models
RUN python -c "from sentence_transformers import CrossEncoder; \
    CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2', backend='onnx'); \
    CrossEncoder('cross-encoder/ms-marco-MiniLM-L-12-v2', backend='onnx')"
```

In the production stage (after line 36 `FROM dependencies as production`), add:

```dockerfile
# Copy pre-downloaded models from dependencies stage
COPY --from=dependencies /opt/models /opt/models
ENV HF_HOME=/opt/models
```

Before `USER appuser` (line 53), add:

```dockerfile
# Make models readable by appuser
RUN chmod -R a+r /opt/models
```

- [ ] **Step 2: Verify Docker build works**

Run: `cd search-service && docker build -t askwri-search:onnx-test .`

Expected: Build completes. Models downloaded during build. Image size increases by ~860MB.

- [ ] **Step 3: Commit**

```
git add search-service/Dockerfile
git commit -m "perf: pre-download reranker models in Docker image

Eliminates ~860MB HuggingFace download on every Fargate cold start.
Both L-6 (cite) and L-12 (answer) models baked with ONNX exports."
```

---

### Task 9: End-to-end verification

- [ ] **Step 1: Run search service locally with torch backend**

```
cd search-service && RERANKER_BACKEND=torch python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Wait for healthy, then run cite mode query:

```
curl -s -X POST http://localhost:8000/query \
  -H "Content-Type: application/json" \
  -d '{"query":"How to build more equal cities","mode":"cite","vector_top_k":500,"bm25_top_k":500,"rerank_top_n":200,"fusion_top_k":200,"rerank":true}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); dbg=d['debug']; print(f'Stage1: {dbg[\"stage1_results\"]} Stage2: {dbg[\"stage2_results\"]} Final: {dbg[\"final_results\"]} fusion_top_k: {dbg[\"mode_config\"][\"fusion_top_k\"]}')"
```

Expected: `Stage1: 200 Stage2: 200 Final: <N> fusion_top_k: 200`

- [ ] **Step 2: Run answer mode query**

```
curl -s -X POST http://localhost:8000/query \
  -H "Content-Type: application/json" \
  -d '{"query":"What role do land value capture mechanisms play?","mode":"answer","vector_top_k":150,"bm25_top_k":150,"rerank_top_n":20,"fusion_top_k":100,"dense_weight":0.65,"sparse_weight":0.35,"rerank":true}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); dbg=d['debug']; print(f'Stage1: {dbg[\"stage1_results\"]} Stage2: {dbg[\"stage2_results\"]} dense_weight: {dbg[\"mode_config\"][\"dense_weight\"]}')"
```

Expected: `Stage1: 100 Stage2: 20 dense_weight: 0.65`

- [ ] **Step 3: Start Next.js app and test full stack**

```
npm run dev
```

Open `http://localhost:3000`, run a cite query, then click "Ask a research question" and submit an answer query. Verify:
- Cite mode returns results with relevance tiers
- Answer mode returns synthesized answer with citations
- No console errors about missing params

- [ ] **Step 4: Verify npm build passes**

```
npm run build
```

Expected: Clean build, no TypeScript errors.

- [ ] **Step 5: Commit any remaining fixes**

If any issues were found and fixed during verification, commit them.
