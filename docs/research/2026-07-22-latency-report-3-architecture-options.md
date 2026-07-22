# End-to-end latency architecture options
(Opus subagent report 3/3 — architecture/strategy lens; raw)

Read-only study of the AskWRI retrieval product on branch `multilingual-v3` (all-Bedrock v3 substrate). Anything not confirmable from code is flagged **[verify against AWS docs]**.

## 1. The full user-perceived latency chain

Two distinct flows. The important structural fact: **the `/query` contract is not the whole story.** Most user-perceived time in the answer flow lives in the Next.js LLM post-processing (`/api/answer`, `/api/alignment`), which is outside the frozen contract and therefore fully in scope for change.

### Flow A — Cite (search results page, `/results?q=`)
Orchestrated by `src/app/results/page.tsx`. Blocking path to first meaningful paint (`doCite`, line 72): browser → POST /api/llamaindex → POST search-service /query mode=cite → [expand → parallel dense (Bedrock embed us-east-1 + ANN) + sparse (BM25) → RRF fusionTopK=200 → Bedrock Rerank 3.5 us-west-2, ≤100 candidates (dominant network term) → floor/tiers/group/normalize] → docs render.

Everything after first paint is **already decoupled and progressive** (prior perf work): `batch-relates` (one gpt-4o-mini call for all "why relates" chips), `alignment` (one gpt-5-mini call ~100 ms after retrieval), summaries (catalog CSV, no LLM), fire-and-forget query log. None block the results list.

**Dominant terms (cite):** the single `/query` round trip — inside it, Bedrock rerank (cross-region) and the query embed, plus two Next proxy hops.

### Flow B — Answer (AI research modal)
Orchestrated by `src/app/components/AnswerMode/AIResearchModal.tsx` (`handleSubmit`, line 94). **Fully blocking** — a spinner covers the modal until synthesis returns (line 327); nothing renders progressively.

1. POST /api/llamaindex mode=answer (+cite_doc_ids) — **a SECOND full hybrid retrieval** (same embed+dense+sparse+RRF as cite, then filters stage1 to cite_doc_ids AFTER retrieval, `main.py:860`), Bedrock rerank top_n=20, page-1 demotion, strip summary nodes.
2. POST /api/answer (synthesis) — [optional] nano filter gpt-5.4-nano (gated USE_NANO_FILTER, default off); synthesis **gpt-5.4 — reasoning model, single NON-STREAMING call** ← dominant term.
3. runAlignment fired in parallel, NOT awaited (line 170) — correctly overlaps.

**Dominant terms (answer):** synthesis (multi-second, non-streaming, behind a spinner — perceived latency equals total latency) >> answer-mode retrieval > optional nano filter.

### Cross-cutting infrastructure findings
- **No query-result cache anywhere.** `AskWRICache` caches only build artifacts. The only result cache is a per-tab React state map (5-min TTL) that dies on reload and isn't shared.
- **Bedrock region split is cross-country.** ECS us-east-2; embed us-east-1; rerank us-west-2. Every query makes a synchronous us-east-2→us-west-2 rerank hop (`ecs.tf:123` documents the split).
- **Answer flow re-retrieves.** Answer mode re-runs the entire hybrid pipeline for a query the user just searched, then post-filters to `cite_doc_ids` rather than restricting up front.
- **Suggestion pool is a fixed, tiny set.** `src/app/components/QuerySuggestions/suggestionPool.ts`: 9 cite + 9 answer canned queries — perfect precomputation targets.

### Prior latency work — landed vs. remaining
Landed on qa: #119 batch cite relates into one LLM call; #121 start alignment immediately after retrieval; parallel dense+sparse. The ONNX/self-hosted reranker perf commits were reverted for v3 — do not revive. Remaining un-addressed: no result caching, no synthesis streaming, no speculative answer retrieval, the double-retrieval in answer mode, cross-region rerank placement.

## 2. Strategic options

**Option 1 — Exact-match result cache in front of `/query`.** Key: hash(normalized request + corpus-version token tied to the existing `content_hash`). In-process LRU first; shared store later. Impact: repeat queries (suggestions, demos, evals) collapse to one hop. Complexity low. Risk: stale-on-reingest if token not bumped. Validate: log normalized-query hash, measure repeat rate.

**Option 2 — Precompute/warm the suggestion pool.** 18 canned suggestions known at build time; warm both modes on start/schedule, optionally pre-run synthesis for the 9 answer suggestions. Very high impact for the default first interaction. Trivial cost. Invalidate on corpus + prompt/model change.

**Option 3 — Stream the synthesis answer.** `/api/answer` is one blocking non-streaming OpenAI call; modal shows only a spinner. Switch to token streaming (SSE/ReadableStream → progressive render). **Biggest single perceived-latency lever in the product.** Does not touch `/query`. Keep citation post-processing as finalize-on-done. Complexity moderate.

**Option 4 — Speculative / overlapped answer retrieval.** (a) Kick off answer-mode retrieval on modal open/hover. (b) Eliminate the redundant second retrieval: pass consulted doc IDs as a retrieval *filter* up front instead of post-filter (safer than reusing cite candidates — presets differ: denseTopK 150 vs 500, rerankTopN 20, page-1 demotion). Gate (b) behind the answer eval. Impact medium-high on the cite→answer journey.

**Option 5 — Co-locate the Bedrock rerank call.** If Rerank 3.5 is available in-east (or via an east-anchored inference profile), point `bedrock_rerank_region` there — trims tens of ms from every query, config-only. **[verify against AWS docs]**. Validate via existing `stage2_time` debug before/after.

**Option 6 — Bedrock throughput/latency levers** (latency-optimized inference, provisioned throughput, profile routing). **Provisioned throughput is a poor fit at QA traffic** (bills for idle reserved capacity; workload is low-QPS/spiky) — deferred to the 10x horizon; first establish a throttle/tail problem exists (CloudWatch Bedrock metrics).

**Option 7 — Semantic (near-duplicate) query cache.** Cache by query embedding within a tight cosine threshold. Only after Option 1 logs prove paraphrase traffic; a loose threshold returns subtly wrong results — a correctness hazard for a research tool. Validate offline on query-log replay first.

**Option 8 — Split and instrument the latency budget explicitly.** No end-to-end per-segment attribution exists across Next proxy → search-service → Bedrock → OpenAI. Add span timing (embed, ANN, BM25, RRF, rerank, synthesis TTFT/total, alignment) to CloudWatch/X-Ray. Prerequisite for proving which of Options 1–7 pays off.

## 3. Suggested sequencing (quick wins → structural)

1. **Option 8 (instrument)** — everything else needs it; confirm region RTT empirically.
2. **Option 5 (co-locate rerank)** — if available in-east **[verify]**, config change helping every query.
3. **Option 3 (stream synthesis)** — largest perceived win, no infra, contract-safe.
4. **Options 1+2 (exact cache + suggestion warmer)** — ship together; ideal for a rarely-changing corpus + fixed suggestions.
5. **Option 4 (kill double retrieval, then speculate)** — structural; eval-gated.
6. **Option 7 (semantic cache)** — only with evidence of paraphrase traffic.
7. **Option 6 (provisioned throughput)** — defer to 10x scale.

## 4. Explicit rejections

- **No in-process / self-hosted models of any kind** (constraint; prior reverts). Region placement is the sanctioned way to cut rerank latency.
- **No `/query` contract changes.** All speedups sit around `/query` or in the frontend/Next tier. Streaming applies to `/api/answer`, not `/query`.
- **Provisioned throughput at current traffic — rejected for now** (pays for idle capacity; problem is likely placement, not throughput).
- **Semantic cache before exact cache — rejected** (correctness hazard until paraphrase volume is proven).
- **Caching without a corpus-version invalidation token — rejected** (a re-ingest is in flight even now; time-only TTL is insufficient).

### Key file references
Cite: `src/app/results/page.tsx` · Answer: `src/app/components/AnswerMode/AIResearchModal.tsx` · Proxy: `src/app/api/llamaindex/route.ts` · Synthesis: `src/app/api/answer/route.ts` · `/query`: `search-service/app/main.py:807` (parallel retrieval :222) · Bedrock: `bedrock_rerank.py`, `bedrock_embed.py`, `config.py:77,82,88` · Presets: `src/config/retrieval.ts` · Suggestions: `suggestionPool.ts` · Regions: `qa.tfvars:7`, `ecs.tf:123`
