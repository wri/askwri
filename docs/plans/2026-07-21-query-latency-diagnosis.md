# /query Latency Diagnosis — QA (2026-07-21)

Status: diagnosed; latency fix not applied (pending decision — retrieval
overhaul is planned). Secondary event-loop bug FIXED on branch
`fix/query-latency` (see below).

## Symptom

Every `/query` on QA takes ~33-35s end to end (measured via
`POST https://qa.askwri-app.org/api/llamaindex`; TTFB 32.98s, so all
server-side, no network component).

## Measurements

| Mode | Stage 1 (retrieval + RRF fusion) | Stage 2 (rerank) | Pairs × model | Total |
|---|---|---|---|---|
| cite | 1.5s | **31.1s** | 200 × ms-marco-MiniLM-**L-6**-v2 | 33.0s |
| answer | 1.0s | **33.6s** | 100 × ms-marco-MiniLM-**L-12**-v2 | 35.0s |

(`debug.stage1_time` / `debug.stage2_time` from live QA responses,
cross-checked against `/ecs/askwri-app-qa-search-service` CloudWatch logs.)

## Root cause

**Cross-encoder reranking is CPU-starved.** Stage 2 scores every fusion
candidate with a local ONNX cross-encoder on a **1 vCPU** Fargate task
(`terraform/environments/qa.tfvars`: `search_service_container_cpu = 1024`;
production has the same value). The workload is ~4 TFLOPs per query
(≈400-token chunks; 200 pairs × 22M-param L-6, or 100 pairs × 33M-param
L-12), which one Fargate vCPU sustains in ~25-34s.

Evidence:

1. **ONNX is loading correctly on QA** — startup logs show
   `Loaded reranker ... with onnx backend` for both models on every boot;
   no torch fallback. Nothing is misconfigured.
2. **Per-pair cost scales exactly with model depth**: 156ms/pair (L-6,
   6 layers) vs 336ms/pair (L-12, 12 layers) — pure compute-bound
   inference, not I/O, locking, or model-loading overhead.
3. **Both modes cost the same total FLOPs** (200×L-6 ≈ 100×L-12), matching
   both landing at ~30s despite different candidate counts.
4. **Effective throughput is ~130 GFLOP/s** — reasonable for a single
   Fargate vCPU running fp32 ONNX. The runtime is performing well; the
   workload is simply too large for one core.
5. **Not a regression.** CloudWatch shows 17-31s Stage 2 times on every
   cite query since at least 2026-07-05 (as far back as the log window
   checked). It has been this slow since the corpus reached full size
   post-cutover. Answer mode was fast pre-cutover only because Stage 1
   returned ~3 candidates against the tiny corpus.

Why the candidate counts are what they are: `src/config/retrieval.ts`
CITE_PRESET sets `fusionTopK: 200`, `rerankTopN: 500` (rerankTopN must be
≥ fusionTopK so the logit floor is the sole quality gate → all 200 fused
candidates get scored). ANSWER_PRESET sets `fusionTopK: 100`,
`rerankTopN: 20` (all 100 scored, top 20 kept — the predict cost is on
fusion candidates, not rerankTopN).

## Secondary bug (found during diagnosis) — FIXED on this branch

`hybrid_query` (`search-service/app/main.py:828`) is `async def` but runs
`hybrid_retriever.retrieve()` (main.py:874) and
`postprocess_nodes()`/`predict()` (main.py:895) synchronously on the
uvicorn event loop. During a ~30s rerank the entire service is frozen:

- `/health` doesn't respond → ALB health-check failures / task-recycling
  risk under load.
- Concurrent user queries serialize behind the running one.

Fix applied (quality-neutral, independent of any latency fix): the
blocking stages — stage 1 hybrid retrieve, stage 2 rerank (both backends),
and the diagnostic-mode retrieves — now run via `asyncio.to_thread(...)`,
mirroring the existing pattern used for index builds (main.py:691,
main.py:1263). Results are byte-identical; only the executing thread
changes. Concurrency safety: retrievers are constructed per-request, the
shared BM25 singleton is read-only at query time (and was already called
from `ThreadPoolExecutor` threads inside `HybridFusionRetriever`), and
`OnnxReranker` was explicitly designed for concurrent calls (per-call
`top_n`, no global mutation; ORT sessions are thread-safe).

Regression test: `search-service/tests/test_query_nonblocking.py` drives
the ASGI app on a single asyncio loop (httpx.ASGITransport), starts a slow
stubbed /query, and asserts /health completes while it runs. Verified
red→green (pre-fix: /health blocked for the full stub duration). Note:
starlette TestClient cannot reproduce this bug — outside its context
manager it creates a fresh event loop per request.

## Fix options (not yet chosen)

| Option | Expected /query latency | Quality risk | Cost / caveats |
|---|---|---|---|
| Bump Fargate CPU 1→4 vCPU (`search_service_container_cpu = 4096`) | ~7-9s (ONNX intra-op parallelism scales near-linearly for these models) | None — rankings bit-identical | ≈ +$90/mo per env; needs `terraform apply` |
| 4 vCPU + int8 dynamic-quantized ONNX rerankers | ~2-4s | Logit scores shift slightly; cite-mode logit-floor thresholds were calibrated on fp32 scores (`search-service/app/config.py:50`, calibrated 2026-03-19) → recalibration needed | Bleeds into retrieval-tuning workstream |
| int8 quantization only (no infra change) | ~10-15s | Same recalibration caveat | No cost/infra change, still slow |
| Fewer rerank candidates (fusionTopK ↓) | proportional | Recall loss — explicitly retrieval tuning | Out of scope per CLAUDE.md |

Recommended when ready: 4 vCPU bump (+ the `asyncio.to_thread` fix in the
same change). Quantization/threshold work belongs to the retrieval-tuning
workstream.

## Repro commands

```bash
curl -s -X POST https://qa.askwri-app.org/api/llamaindex \
  -H 'Content-Type: application/json' \
  -d '{"query":"deforestation in the Amazon","mode":"cite"}' \
  -w 'total=%{time_total}s'   # inspect .debug.stage1_time / .debug.stage2_time

aws logs filter-log-events --log-group-name /ecs/askwri-app-qa-search-service \
  --filter-pattern "Stage 2" --query "events[].message"
```
