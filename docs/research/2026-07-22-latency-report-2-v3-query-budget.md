# v3 /query latency budget and optimization plan
(Opus subagent report 2/3 — v3 pipeline lens; raw, pending synthesis)

Scope: `search-service` `/query` on branch `multilingual-v3`, `RETRIEVAL_BACKEND=postgres`, `KEYWORD_BACKEND=sparse`, `EMBEDDING_MODEL=cohere-embed-v4`. Deployed infra: ECS Fargate **us-east-2**, 1 vCPU / 8 GB, `desired_count=1` (`terraform/environments/qa.tfvars:7,42-44`). Embed hop **us-east-1**, rerank hop **us-west-2** (`app/config.py:77,82`).

Important correction to the brief: the live cite path does **not** use `vector_top_k=800/bm25_top_k=800`. The Next.js gateway overrides the `QueryRequest` defaults (which are 500, `app/main.py:138-139`) with `CITE_PRESET`: `denseTopK=500`, `sparseTopK=500`, `fusionTopK=200`, `rerankTopN=500`, `maxResults=100` (`src/config/retrieval.ts`). `rerank_candidates=100` is the real cut sent to Bedrock (`app/config.py:88`). So the pipeline fetches 500+500 → fuses to 200 → per-doc-caps/cuts to 100 → reranks 100 → floors → groups → returns ≤100.

Also correcting the double-call assumption: in the production UI, `/query` is called **once per user query** (cite only — `src/app/results/page.tsx:75`). Answer synthesis (`src/app/api/answer/route.ts`) receives the already-retrieved `docs` in its request body and does **not** re-hit `/query`. The `answer`-mode + `cite_doc_ids` path on `/query` is exercised by evals / `multi-query-strategy`, not the main chat flow. This materially weakens the "same query hits /query twice" premise for prod (it holds for evals and user re-searches only).

## 1. Stage-by-stage budget (deployed, us-east-2, warm process, cite mode)

| Stage | Est. (warm) | Serial/Parallel | Evidence |
|---|---|---|---|
| Query expansion (BM25 lane only) | <1 ms | serial, pre-thread | `app/main.py:216`; `query_expansion.py:246` — pure in-proc dict lookup, no network |
| **Dense lane**: Bedrock embed-v4 encode (us-east-1) | 50–130 ms | parallel (thread A) | `app/bedrock_embed.py:54,71`; cross-region RTT ~12 ms + single short-text inference |
| **Dense lane**: pgvector ANN (`ef_search=1000`, `LIMIT 500`, 30k×1536) | 20–60 ms | parallel (thread A, after embed) | `app/pg_store.py:115-119`, `_DENSE_SQL_TMPL` 36-45 |
| **Sparse lane**: vocab lookup + exact inner-product scan (`LIMIT 500`, 30k rows) | 20–50 ms (two DB round-trips) | parallel (thread B) | `app/pg_store.py:167-183`; `_SPARSE_KEYWORD_SQL` 130-139 |
| Fusion wall time = **max(dense, sparse)** | **~90–190 ms** | — | `HybridFusionRetriever._retrieve` `app/main.py:222-224` (ThreadPoolExecutor, workers=2) |
| RRF fusion + sort (~1000 nodes → 200) | 1–4 ms | serial | `app/main.py:253-286` |
| **Rerank**: Bedrock Rerank 3.5 (us-west-2), 100 inline full-chunk docs | **300–650 ms** | serial (dominant) | `app/bedrock_rerank.py:99-117`; cross-region RTT ~50 ms + 100-passage inference; spec §9 calls rerank the dominant hop |
| Floor / tiers / doc-grouping | <5 ms | serial | `app/main.py:917-952` |
| Passage-context assembly (`find()` per final doc, ≤100) | 5–40 ms typical; **spikes to 100s ms** worst case | serial | `get_passage_with_context` `app/main.py:353-412`, called at `1011` |
| Response build / serialize | 2–10 ms | serial | `app/main.py:962-1097` |
| **Total (warm)** | **~0.45–0.95 s** | rerank ≈ 55–70% of budget | consistent with spec §9 0.6–1.1 s and local 1.0–1.9 s (two cross-region hops from a laptop add RTT) |

Cold-process first query additionally pays: lazy boto3 client construction + TLS handshake for **each** Bedrock region (`get_client()` singletons built on first use, `bedrock_embed.py:29-43`, `bedrock_rerank.py:31-45`), and possible 2nd pgvector pool connection open (`db.py:24-30`, `min_size=1`). One-time ~200–500 ms.

## 2. Ranked optimizations

**O1 — Co-locate the Bedrock models in the infra region (us-east-2) if available.**
Saving: ~50–100 ms/query (kills the us-west-2 rerank RTT, the single biggest fixed tax) + ~12–24 ms (embed). Effort: S (change `bedrock_rerank_region`/`bedrock_embed_region`, `app/config.py:77,82`). Quality: none. **VERIFY AGAINST AWS DOCS** — config comments claim embed-v4 is us-east-1/eu/tokyo-only and Rerank 3.5 is us-west-2/ca-central/eu-central-only (`bedrock_embed.py:7-10`, `bedrock_rerank.py:14-18`). I cannot confirm us-east-2 availability; check Bedrock model-region support (and whether a us-east-2 **cross-region inference profile** exists) before assuming this is possible. If only one model can move, prefer moving **rerank** (bigger RTT).

**O2 — Warm the boto3 clients + a DB connection at load time.**
Saving: removes the one-time cold-start tail (~200–500 ms) from the first real user query after each deploy/scale-out; also protects p99 on cold ECS tasks. Effort: S — call `bedrock_embed.get_client()`, `bedrock_rerank.get_client()`, and a trivial `SELECT 1` during `load_from_postgres()` (`app/main.py:644-654`). Quality: none.

**O3 — Add a botocore `Config` with tuned timeouts + retries to both clients.**
Today neither client passes a `Config`, so defaults apply: 60 s connect/read timeout, legacy retry mode (up to 5 attempts). A stalled embed call blocks the whole request up to 60 s before the sparse-only degradation path can even trigger (the degrade is exception-driven, `app/main.py:230-241`). Set `connect_timeout≈2s, read_timeout≈8-10s, retries={"mode":"standard","max_attempts":2}, max_pool_connections≈10`. Effort: S (`bedrock_embed.py:38-42`, `bedrock_rerank.py:40-44`). Quality: none (improves p99/resilience, not median). This is the highest-value robustness change.

**O4 — Query-embedding LRU cache.**
Saving: full embed hop (~50–130 ms) on cache hit. Effort: S — wrap `embed_query` (`bedrock_embed.py:69`) in a small bounded LRU keyed by the query string (input_type is always `search_query`, so it's deterministic). Quality: none. Value caveat: main UI calls cite once per query, so prod hit-rate comes only from user re-searches and identical concurrent queries; **eval loops (which rerun fixed golden sets) benefit most**. Worth it because it's tiny and risk-free, but don't oversell prod impact.

**O5 — Reduce the rerank candidate count / passage payload for cite.**
Rerank cost scales with candidate count and per-passage token length (`bedrock_rerank.py:99-117` sends `node.get_content()` — full chunk text ×100). Cutting `rerank_candidates` (e.g. 100→60) or truncating each passage would directly reduce the dominant hop. Saving: potentially 100–250 ms. Effort: S. Quality: **needs-eval, and explicitly flagged risky** — the cite floor/tiers were *just* derived on the 100-candidate, per-doc-capped pool, and `config.py:106-108` itself says "re-derive with `scripts/capture_cite_scores.py` after candidate-pool changes." Do not ship without re-running that calibration.

**O6 — Eliminate `find()` in passage assembly by persisting chunk offsets.**
`get_passage_with_context` scans the full doc text per result; on a miss it hits a normalized-whitespace fallback that rebuilds the entire document string via `' '.join(text.split())` (`app/main.py:364-367`) — O(doc length) allocation, ×up to 100 results, is the worst-case spike source. Fix: store the chunk's char start-offset in `document_chunks.node_metadata` at ingest, then slice directly (O(1)). Saving: small median, large worst-case; also removes "context match failed" markers. Effort: M (ingest metadata + query-side read; touches worker, outside the frozen `/query` contract). Quality: none (identical passage text). NOTE: Phase C's heading-aware chunking with char_start/char_end delivers exactly this.

**O7 — Lower `hnsw.ef_search` and/or the 500-fetch for dense.**
`ef_search=1000` with `LIMIT 500` over-explores a 30k-row / 171-doc corpus when only 200 survive fusion and 100 reach rerank. Dropping `ef_search` to ~200–400 and `vector_top_k`/`bm25_top_k` toward ~250 would trim the DB stage. Saving: ~10–30 ms. Effort: S (`pg_store.py:115`; presets in `src/config/retrieval.ts`). Quality: needs-eval (recall of the RRF tail) — low risk since fusion keeps only 200 and rerank only 100, but confirm on the cite golden set. Low priority given the modest saving.

**O8 — Collapse the sparse lane's two DB round-trips into one.**
`SparseKeywordRetriever` does a `keyword_vocab` lookup and then the scored scan as two separate `get_pool().connection()` checkouts (`pg_store.py:167-183`). A single statement (CTE/join resolving tokens inline) removes one round-trip. Saving: ~2–5 ms. Effort: M. Low priority.

## 3. Instrumentation gaps and minimal additions

What exists today: only two coarse timers — `stage1_elapsed` (entire fusion, `main.py:839-855`) and `stage2_elapsed` (rerank, `main.py:876-884`), surfaced as `debug.stage1_time`/`stage2_time`. That is insufficient because:

- **Dense vs sparse are not separated**, and within dense, **embed time is not isolated from pgvector time** — the single biggest unknown (O1/O4/O7 all hinge on it).
- **Rerank has no split** between network RTT and model inference — can't tell if O1 (region) or O5 (candidate count) is the lever.
- **Passage assembly is untimed** — the worst-case spike (O6) is invisible.
- No **total request timer**, no **cold-vs-warm** marker, no **per-region Bedrock call** timing.

Minimal additions (all inside existing files, no contract change — extra keys go in the already-open-ended `debug` dict):
1. Wrap `embed_query` and the pgvector `conn.execute` separately in `PgVectorRetriever._retrieve` (`pg_store.py:106-127`); wrap the sparse scan in `SparseKeywordRetriever._retrieve`. Return `debug.embed_ms`, `debug.dense_db_ms`, `debug.sparse_ms`.
2. In `BedrockReranker.postprocess_nodes`, time the `get_client().rerank(...)` call alone (`bedrock_rerank.py:99`) → `debug.rerank_api_ms`.
3. Time the passage-assembly loop (`main.py:971-1043`) → `debug.passage_ms`.
4. Add `debug.total_ms` + a `debug.cold` flag.
5. For deployed histograms: emit these as **CloudWatch EMF** metric lines (embed_ms, dense_db_ms, sparse_ms, rerank_api_ms, passage_ms, total_ms) so p50/p90/p99 are queryable. Only way to empirically confirm rerank-dominates and size O1/O5 before touching quality-affecting knobs.

## 4. Explicit non-recommendations

- **Don't rewrite the retrievers as native async (asyncpg/async httpx).** The `ThreadPoolExecutor(max_workers=2)` already overlaps the two IO-bound lanes; boto3/psycopg release the GIL during IO. L effort for ~0 median gain at `desired_count=1`.
- **Don't move the ECS service to us-east-1 to co-locate embed.** Rerank (us-west-2) is the larger RTT and would become *more* distant. Co-locate the *models* to us-east-2 (O1), don't move the infra.
- **Don't cache rerank results.** Output depends on (query × exact candidate set × order); hit rate near-zero, fragile keys.
- **Don't pool/reuse the per-request ThreadPoolExecutor.** Thread-spawn is sub-ms against a ~0.5 s budget.
- **Don't remove query expansion.** Local dict lookup (<1 ms) aiding sparse recall.
- **Don't shrink the DB pool or `max_pool_connections`.** Not on the critical path; shrinking risks contention.
- **Beware the diagnostic path double-embeds.** `return_intermediate_results=true` runs dense once for diagnostics (`main.py:830-831`) and again inside fusion — never enable on the hot path.

**Net:** deployed budget is rerank-dominated (~55–70%). Safe high-leverage: O1 (region co-location, pending AWS-docs verification), O2/O3 (warmup + botocore timeouts — pure tail/resilience wins), O4 (embed cache). Any candidate-pool knob (O5) gates on re-deriving the cite floor/tiers. Add the §3 timers before committing to O1/O5.
