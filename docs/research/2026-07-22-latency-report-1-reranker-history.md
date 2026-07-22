# The /query reranker latency problem — history and current state
(Opus subagent report 1/3 — history/diagnosis lens; raw)

## 1. Mechanics of the deployed slowness (with numbers)

**What runs on deployed qa.** The `/query` endpoint is `async def hybrid_query` (`search-service/app/main.py:828`). Stage 2 reranking uses an **in-process cross-encoder** via sentence-transformers' `CrossEncoder`, wrapped in `OnnxReranker` (`main.py:173-208`). The backend is ONNX (`reranker_backend = "onnx"`, `search-service/app/config.py:59`). Loaded models:
- Answer mode: `cross-encoder/ms-marco-MiniLM-L-12-v2` (33M params) — `config.py:56`, loaded `top_n=20` (`main.py:443/453`).
- Cite mode: `cross-encoder/ms-marco-MiniLM-L-6-v2` (22M params) — `main.py:438`, loaded `top_n=1000` (`main.py:448/458`).

**The cost driver is candidate count, not top_n.** `OnnxReranker.postprocess_nodes` builds a `[query, chunk_content]` pair for **every** stage-1 candidate and scores them all in one `predict()` call (`main.py:200-202`); `top_n` only slices the *output* afterward (`main.py:208`). So per-query CPU cost ≈ (number of stage-1 candidates) × (per-pair cross-encoder forward pass).

**How many candidates reach the reranker in cite mode.** Request defaults: `vector_top_k=500`, `bm25_top_k=500`, cite `fusion_top_k` default = 500. RRF fusion therefore hands Stage 2 up to ~500 candidate chunks. This matches the load-bearing comment in `evaluation/lib/service-client.ts:12-14`:

> "Local cite-mode queries rerank 500+ candidates on CPU and can exceed undici's default 300s headersTimeout; an aborted fetch leaves the service reranking a zombie request and cascades into concurrent slowdowns."

That comment quantifies the failure envelope directly: a single cite query can take **> 300 s (5 min)** of CPU rerank time, forcing the eval client to raise its timeout to 1,800,000 ms (30 min) (`service-client.ts:15`). Implied per-pair cost at the 300 s boundary is ≈ 300 s / 500 ≈ **0.6 s per query-doc pair** worst case.

**Hardware.** Deployed qa runs the search service on a **single Fargate task, 1 vCPU (1024 CPU units), 8 GB**, `desired_count = 1` (`terraform/environments/qa.tfvars:42-44`); production is identical (`production.tfvars:42-44`). ECS CPU/memory autoscaling is commented out (`terraform/infrastructure/ecs.tf:477-505, 812-831`). So all candidate scoring is serial on one vCPU with no horizontal relief.

**Corroborating historical magnitudes** (same in-process cross-encoder path, larger models/hardware): the heavy `bge-reranker-v2-m3` (568M params) produced "**~2.9 min query times on 2 Fargate vCPUs**" (commit `1ff7822`); and the Voyage-swap commit states "**local cross-encoders took 28s on Fargate**" (commit `a936471`). The 22M/33M MiniLM models deployed now are lighter, but the ~500-candidate cite fan-out keeps single-query latency in the tens-of-seconds-to-minutes band under load — hence the `service-client.ts` 300 s escape hatch.

**Concurrency amplifier.** The cross-encoder `predict()` is CPU-bound and is called **inline in the async handler** — there is no `asyncio.to_thread` / `run_in_executor` around Stage 1 or Stage 2 on qa (`main.py:874, 895`). A single rerank therefore blocks the event loop, serializing all concurrent `/query` requests — exactly the "cascades into concurrent slowdowns" the comment describes.

## 2. Timeline of band-aids (with commits)

| Date | Commit / branch | Band-aid | On deployed qa? |
|---|---|---|---|
| 2026-03-08 | `959d176` "Increase ALB timeout" | ALB 504s for >1 min requests; raised `idle_timeout` to **300 s** (`terraform/infrastructure/alb.tf:12`). Pure timeout relief. | Yes |
| 2026-03-09 | `1ff7822`, PR #91 `kg-lightweight-reranker-perf` | Swap answer reranker `bge-reranker-v2-m3` (568M) → `ms-marco-MiniLM-L-6-v2` (22M): heavy model caused "~2.9 min query times on 2 Fargate vCPUs." | Yes |
| 2026-03-21 | `817c9dd`/`1ea48a0` | Parallelize dense + sparse retrieval (Stage 1, not the reranker). | Yes |
| 2026-03-21 | `d4bdd7e`→`e334464`→`6fc4b1f` (#125) | `OnnxReranker` wrapper + ONNX runtime backend + per-request race fix. **Newest reranker-perf commit actually on qa.** | Yes |
| 2026-03-21 | `9917bbf` "uncap cite reranker top_n" | Raised cite `top_n` 200 → 1000 (recall fix; increases surviving tail, not count scored). | **No** |
| 2026-03-21 | `a936471` | Replace local cross-encoders with **Voyage rerank-2.5 API** — "local cross-encoders took 28s on Fargate; Voyage completes in <1s." First real offload fix. | **No** (superseded) |
| 2026-07-07 | `8383815` → revert `1d7858d` → `b76053c` | Self-hosted bge tried/reverted; **Cohere Rerank 3.5 via Bedrock**. | No (v3 lineage) |
| 2026-07-21 | `d214f3f` "run /query retrieval and reranking off the event loop" | The concurrency fix (offload blocking work off the event loop), with tests + diagnosis doc. | **No — on neither qa nor v3** |

Deployed qa is thus stuck at the `6fc4b1f` ONNX era: MiniLM cross-encoders scoring ~500 cite candidates in-process on 1 vCPU, behind a 300 s ALB timeout. Every genuine offload fix (Voyage, Bedrock, off-event-loop) landed on branches that are not on qa.

## 3. What multilingual-v3 already fixes, and expected deployed latency

**The swap.** `search-service/app/bedrock_rerank.py` replaces the in-process `OnnxReranker` for **both** modes with `BedrockReranker` (Cohere `cohere.rerank-v3-5:0`). This eliminates all CPU cross-encoder work from the request path — the dominant cost term in §1 disappears.

**Candidate cut.** Instead of scoring ~500 candidates on CPU, the client sends only `rerank_candidates = 100` fused candidates to Bedrock, with a per-doc cap so 100 slots cover more distinct docs. The un-reranked tail is dropped so RRF and 0-1 relevance scores never mix.

**Budgeted latency** (spec §9): dense encode ~100–250 ms; sparse ~5–20 ms; Postgres ~20–80 ms; **rerank ~400–700 ms (dominant)**; fusion+assembly ~30–80 ms; **end-to-end ~0.6–1.1 s**.

**Measured** (cutover report): "lanes ~0.7–1.2 s, rerank path ~1.2–1.9 s per query from a laptop with two cross-region hops."

**Net effect:** deployed cite-query latency drops from the tens-of-seconds-to->300 s regime to roughly **1–2 s per query** — ~2 orders of magnitude on the pathological cite path; the 300 s ALB timeout stops being load-bearing. Cite eval quality held.

## 4. Residual latency problems that REMAIN after the v3 merge

1. **The blocking rerank call still runs on the event loop.** In the v3 worktree, Stage 1 `hybrid_retriever.retrieve()` (`main.py:854`) and Stage 2 `postprocess_nodes()` (`main.py:879`) are still called synchronously inside `async def hybrid_query`. boto3's Rerank call is a blocking socket round-trip, so during the ~400–700 ms Bedrock RTT the event loop cannot service other coroutines. The fix `d214f3f` is confirmed **not** an ancestor of the v3 HEAD (nor of qa). Consequence (estimate): N simultaneous cite queries ≈ N × ~0.5–1 s tail latency, on a single-task/1-vCPU service.

2. **Two cross-region Bedrock hops.** Infra us-east-2; rerank us-west-2, embed us-east-1. Every query pays two cross-region RTTs. Spec §9 flags the hop as an unoptimized lever.

3. **Rerank is still the single dominant hop** (~400–700 ms of ~0.6–1.1 s) and scales with `rerank_candidates` — the same sensitivity that caused the original problem, at hosted-API scale.

4. **No horizontal scaling.** `desired_count = 1`, 1 vCPU, autoscaling commented out. v3 does not change this.

5. **Measured numbers are laptop-side, not in-region Fargate.** Treat the ~1–2 s deployed projection as an estimate pending in-cluster measurement.
