# /query Latency Workstream — Synthesis and Sequenced Plan

**Date:** 2026-07-22 · **Inputs:** three independent Opus analyses (raw reports
in `docs/research/2026-07-22-latency-report-{1,2,3}-*.md`: history/diagnosis,
v3 stage budget, architecture options) + `docs/plans/2026-07-21-query-latency-diagnosis.md`
(on branch `fix/query-latency`).
**Constraints (non-negotiable):** `/query` contract frozen · NO self-hosted /
in-process models · any candidate-pool change re-derives the cite floor/tiers
(`scripts/capture_cite_scores.py` + `analyze_cite_scores.py`) · answer-flow
changes gate on `npm run eval:answer-retrieval`.

## Where the three analyses converge

1. **The deployed problem is already solved ~100× by multilingual-v3.**
   Deployed qa reranks ~500 candidates through an in-process ONNX
   cross-encoder on 1 vCPU — worst case **>300 s/query** (the eval client
   carries a 30-min timeout for exactly this), with the ALB timeout raised to
   300 s as a band-aid, and the CPU-bound rerank blocking the event loop so
   concurrent queries serialize. v3's Bedrock Rerank swap (100-candidate cut,
   hosted API) collapses this to a projected **~1–2 s/query**. Merging v3 IS
   the latency fix for the abiding problem.
2. **Post-v3, rerank remains the dominant hop** (~400–700 ms, 55–70% of the
   budget) and the two cross-region hops (embed us-east-1, rerank us-west-2
   from infra in us-east-2) are the biggest fixed tax.
3. **Instrumentation is inadequate everywhere.** Only two coarse timers exist
   inside `/query`; embed vs pgvector vs rerank-RTT vs rerank-inference are
   indistinguishable, passage assembly is untimed, and nothing reaches
   CloudWatch as a histogram. Every sizing claim above is an estimate until
   this lands.
4. **An off-event-loop fix already exists and is stranded**: commit `d214f3f`
   on `fix/query-latency` ("run /query retrieval and reranking off the event
   loop", with tests + diagnosis doc) is on neither qa nor v3. Without it,
   even v3's ~0.5–1 s Bedrock rerank blocks the single event loop and
   concurrent queries serialize.

## Key corrections the deep-dive surfaced (update your mental model)

- The live cite path uses presets 500/500 → fuse 200 → rerank 100 (not the
  800/800 the eval scripts use).
- In the production UI, `/query` runs **once** per user query (cite);
  answer synthesis receives the docs in its request body. The "same query
  embeds twice" effect applies to evals and the cite→answer modal journey
  (which re-retrieves), not the basic search flow.
- The perceived-latency king in the answer flow is **the non-streaming
  gpt-5.4 synthesis call behind a full-modal spinner** — outside `/query`
  entirely, fully changeable.

## Sequenced plan

### L0 — on the v3 branch before/at merge (small, zero quality risk)
1. **Adopt `d214f3f` (off-event-loop)** — cherry-pick/adapt onto v3 (23 lines
   in main.py + tests; expect a small conflict with the v3 rerank changes).
2. **Instrumentation**: per-stage timers into the open-ended `debug` dict
   (`embed_ms`, `dense_db_ms`, `sparse_ms`, `rerank_api_ms`, `passage_ms`,
   `total_ms`, `cold` flag) + CloudWatch EMF emission for deployed
   p50/p90/p99.
3. **botocore `Config` on both Bedrock clients**: connect_timeout≈2s,
   read_timeout≈8–10s, retries standard/2, max_pool_connections≈10. Today's
   defaults mean a stalled embed blocks a request up to 60 s before the
   sparse-only degradation can trigger. Highest-value robustness change.
4. **Warm boto3 clients + one DB connection at boot** (kills the ~200–500 ms
   cold-start first-query tail).
5. **Query-embedding LRU cache** (tiny, risk-free; biggest wins in evals and
   re-searches).

### L1 — verify-then-config
6. **Region placement**: verify (AWS docs / list-foundation-models) whether
   Rerank 3.5 and/or embed-v4 are invokable in-east (natively or via an
   east-anchored inference profile). If yes: config change, ~50–100 ms off
   every query. If only one can move, move rerank.

### L2 — perceived latency (frontend/Next tier, outside the frozen contract)
7. **Stream the synthesis answer** (`/api/answer` → SSE; finalize citations
   on stream end). The single largest perceived-latency lever in the product.
8. **Exact-match result cache + suggestion-pool warmer** (ship together; key
   includes a corpus-version token tied to `content_hash` — a re-ingest was
   literally in flight while this plan was written).
9. **Kill the answer-mode double retrieval**: pass consulted doc IDs as an
   up-front retrieval filter instead of a post-filter. Eval-gated.

### L3 — deferred / evidence-gated
- Semantic query cache (needs paraphrase-traffic evidence from L2's cache
  logs; correctness hazard otherwise).
- Bedrock provisioned throughput (poor fit at low/spiky QPS; revisit at 10×
  with throttle evidence).
- `rerank_candidates` / passage-payload trims (real 100–250 ms available, but
  gates on floor/tier re-derivation — bundle with the next calibration pass).
- ef_search / lane top_k trims (~10–30 ms; same eval gate, low priority).

### Explicitly rejected (all three analyses agree)
- In-process/self-hosted anything (constraint; twice reverted).
- Async rewrite of the retrievers (thread overlap already works; L effort, ~0 gain).
- Rerank result caching (near-zero hit rate, fragile keys).
- Moving ECS to chase one model's region (co-locate models, not infra).
- `/query` contract changes of any kind.

## Suggested ownership note

L0 items belong on the multilingual-v3 branch (they touch the same files and
should ride the same PR/eval cycle). L2 items are frontend/Next work that can
proceed independently of the retrieval branch — good parallel track for
another contributor.
