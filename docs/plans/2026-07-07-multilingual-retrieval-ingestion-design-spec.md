# AskWRI — Multilingual Retrieval + Ingestion Upgrade: Design Spec (v3)

**Date:** 2026-07-07
**Status:** Approved for implementation (hand-off to Claude Code)
**Version:** v3 — **all-Bedrock, no self-hosted models.** v1 put a self-hosted BGE substrate inside the 1-vCPU search-service (infeasible). v2 moved the BGE models to a dedicated self-hosted inference service (brittle BGE-M3 sparse tooling + one always-on task *per env*). v3 eliminates the service entirely: **dense = Cohere embed-v4 on Bedrock, rerank = Cohere Rerank 3.5 on Bedrock, sparse = the existing English Postgres lane retained; multilingual learned sparse is deferred (evidence-gated, Appendix A).** If you started against v1/v2/the earlier kickoff, read §0.1 first.
**Branch target:** `qa-wip-david`

---

## 0. Kickoff (paste into Claude Code)

```
You are implementing the AskWRI multilingual retrieval + ingestion upgrade (v3 spec:
docs/plans/2026-07-07-multilingual-retrieval-ingestion-design-spec.md). Read it fully first.

Branch qa-wip-david. TDD, conventional commits (no Co-Authored-By), stage files explicitly.
Obey §11 constraints (raw-SQL migrations, write-ownership, preserve the /query contract shape).
Python: cd search-service && ./venv/bin/python -m ...

Architecture in one line: DENSE = Cohere embed-v4 via AWS Bedrock; RERANK = Cohere Rerank 3.5
via AWS Bedrock; SPARSE = the EXISTING English Postgres bm25s lane, unchanged. NO self-hosted
models, NO new inference service. The 1-vCPU search-service stays model-free and calls
Bedrock + Postgres. Multilingual learned sparse is DEFERRED (Appendix A) until the golden set
proves a non-English exact-match gap.

The golden set is BLOCKED on staffing — do NOT wait for it; use the non-English smoke set
(commit 1f8092d) + hand spot-checks as the interim gate, leaving TODO(golden-set) markers.

Start order: B1 dense→Bedrock (embed-v4), then B2 rerank→Bedrock (Rerank 3.5) + re-derive the
cite threshold/tiers on a 0-1 score scale. Phase C (Gemini ingestion) runs in parallel. PAUSE
for review before the full-corpus re-embed cutover.
```

### 0.1 Corrective for implementers already in Phase B (READ IF YOU STARTED)

Earlier kickoffs told you to **self-host bge-reranker-v2-m3 via the in-process ONNX loader (`main.py:437-458`)** and/or **swap `embed.py` to a self-hosted BGE-M3 model**, or (v2) to **stand up a dedicated inference service.** **All of that is superseded.** Correct end-state:

- **No self-hosted models anywhere. No new inference service.** Revert any change that loads BGE-M3 or bge-reranker in-process, and do not provision the v2 inference-service ECS task. Commit the revert as `revert: self-hosted BGE models/inference service (superseded by all-Bedrock arch, spec v3)`.
- **Dense = Cohere embed-v4 via Bedrock.** `embed.py`'s embedding call and the query-side dense encode move from OpenAI `text-embedding-3-small` to **Bedrock Cohere embed-v4** — an API call, not a self-hosted model.
- **Rerank = Cohere Rerank 3.5 via Bedrock.** Replace the in-process `OnnxReranker` load/call (`main.py:437-458`) with a **Bedrock Rerank API client**. Cohere Rerank returns **0–1 relevance scores**, so the `cite_logit_floor = -9.0` (`config.py:51`) + strong/partial/weak tiers are **re-derived on a 0–1 scale**, not recalibrated as logits.
- **Sparse = unchanged.** Keep the existing English `bm25s` Postgres lane (`app.sparse_keyword`, `document_chunks.sparse`, `SparseKeywordRetriever`) exactly as-is. Do **not** retire `keyword_vocab`/`keyword_corpus_stats`.
- **Re-plan against this v3 spec** from Phase B1. Keep eval/test scaffolding; discard self-hosted model-serving code.

---

## 1. Summary

AskWRI searches a multilingual corpus (**en, zh, es, pt**). The renditions/ingest layer is correct; the **retrieval substrate is the monolingual-English baseline** (text-embedding-3-small dense; English `bm25s` sparse; an English `ms-marco-MiniLM` reranker whose English-calibrated cite floor silently drops Chinese). Target infra is small — **search-service = 1 vCPU / 8 GB Fargate, no GPU** — and we want minimal new ops across **two environments (qa + prod)**.

v3 fixes multilingual retrieval with **managed Bedrock APIs only**: **Cohere embed-v4 (dense) + Cohere Rerank 3.5 (rerank)**, both native on Amazon Bedrock (in-AWS, IAM, unified billing). The existing English Postgres sparse lane is **retained** for en→en. **Multilingual learned sparse is deferred** — a real but narrow capability (non-English exact-term matching) that we build only if the golden set proves it's needed (Appendix A). Interface stays **English-display for v1**. The 1-vCPU search-service stays **model-free**; no new self-hosted service in either environment.

## 2. Goals / Non-goals

**Goals (v1)**
- Real cross-lingual retrieval: English query reaches zh/es/pt docs (rides multilingual **dense + reranker**).
- Remove the harmful English reranker + English-calibrated cite floor.
- **Zero new self-hosted infrastructure** — nothing extra to keep alive in qa or prod.
- Higher-fidelity multilingual parsing with a hallucination/garble gate (§7).
- Preserve the `/query` request/response **shape**.

**Non-goals (deferred past v1)**
- **Multilingual learned sparse** (non-English exact-term matching) — evidence-gated; Appendix A.
- Non-English **interface**: query translation, answer-in-query-language synthesis.
- voyage-context-4 / contextualized-chunk embeddings; self-hosted VLM parser; GraphRAG/ColPali.

**Near-term follow-ups (next, not v1 — leave seams)**
- **Passage-snippet translation** (§3).
- **Per-language cite threshold/tier recalibration** on the golden set (v1 ships conservative + smoke-set).

## 3. Locked product decision — English-display v1

- **UI, result titles, result summaries in English** via `documents.title_en` / `document_summaries(language='en')`.
- **Queries may be any language** — multilingual dense + reranker resolve non-English queries. No query translation.
- **Answer mode** synthesizes in **English** for v1.
- **Passage handling — LOCKED interim (translation deferred):** result body = English `title_en` + `summary_en`; the matched **native passage is shown beneath, labeled with its language.** Not 100% English for the ~33 non-English docs' passages — accepted temporary compromise. Snippet translation is the first post-v1 follow-up; leave the seam.

## 4. Locked component decisions

| Lane | Decision | Where it runs | Notes |
|---|---|---|---|
| **Dense** | **Cohere embed-v4** (replaces text-embedding-3-small) | **AWS Bedrock** (managed API) | 1536-d → fits existing HNSW width; $0.12/M. Query encode = API call, same shape as today's OpenAI call. |
| **Rerank** | **Cohere Rerank 3.5** (replaces ms-marco-MiniLM) | **AWS Bedrock** (managed Rerank API) | Multilingual (zh/pt/es/en explicit). Returns **0–1 relevance scores** → cite threshold/tiers **re-derived on 0–1**. Reduce candidate set (~50–100) before the call (API cost/latency scale with doc count). |
| **Sparse** | **Existing English `bm25s` Postgres lane — UNCHANGED** | Postgres (RDS) | Helps en→en; zero new cost. Multilingual learned sparse **deferred** (Appendix A). |
| **Serving** | **None new** | — | Search-service stays model-free; calls Bedrock + Postgres. Nothing to keep alive per-env. |

**Dense rationale (researched 2026-07-07):** Gemini Embedding 2 has the best raw multilingual/cross-lingual numbers (MMTEB 69.9, cross-lingual 0.997) but runs on Google Cloud (egress). **Cohere embed-v4 is near-top on multilingual AND native on Bedrock**, 1536-d fits pgvector. For a constrained-AWS target, operational fit tips it to Cohere; **Gemini Embedding 2 is the A/B challenger** when the golden set unblocks. Caveats: Portuguese under-benchmarked industry-wide (validate on own docs); zh among APIs not cleanly ranked publicly — golden set is the arbiter.

**Why not self-host BGE (v2, dropped):** the only thing self-hosting bought was multilingual *learned sparse*, whose tooling is brittle (BGE-M3 sparse isn't cleanly served by TEI/Infinity → needs a custom FlagEmbedding wrapper) and which would require an **always-on service in both qa and prod**. Its value is narrow (non-English exact-term matching) and evidence-gated. With Cohere Rerank now on Bedrock, both lanes we need are managed APIs, so the service is unjustified for v1. Preserved as Appendix A.

## 5. Retrieval lanes (v1)

- **Dense:** query → Bedrock embed-v4 → pgvector HNSW ANN. Multilingual; carries cross-lingual recall.
- **Sparse:** existing English `bm25s` → `document_chunks.sparse` inner-product in Postgres. en→en only; unchanged.
- **Fuse:** weighted RRF (existing `HybridFusionRetriever`), then reduce to a small candidate set (~50–100).
- **Rerank:** Bedrock Cohere Rerank 3.5 over the candidate set → 0–1 scores → cite threshold/tiers (re-derived on 0–1) → display via `title_en`/`summary_en` + labeled native passage.

**Region nuance (verify at setup):** infra is us-east-2; embed-v4 is in us-east-1/eu/tokyo and Rerank 3.5 in us-west-2/ca-central/eu-central. Neither is natively us-east-2 → use Bedrock **cross-region inference** (still in-AWS/IAM/unified-billing, small latency hop). Confirm inference-profile availability + IAM in the deploy setup.

## 6. Target architecture

```
QUERY PATH (search-service, 1 vCPU, model-free):
  query
   ├─ dense encode → Bedrock Cohere embed-v4 (API)
   └─ sparse encode → English bm25s (in-process, cheap; unchanged)
        → Postgres: dense HNSW ANN ∥ sparse inner-product (RDS)
        → weighted RRF → small candidate set (~50–100)
        → Bedrock Cohere Rerank 3.5 (API) → 0–1 scores
        → cite threshold/tiers (RE-DERIVED on 0–1)
        → display via title_en / summary_en (+ labeled native passage)

INGEST PATH (worker task):
  Gemini parse → validate → langdetect → summarize(native+en) → classify
   → chunk (heading-aware, offsets) → dense embed (Bedrock embed-v4)
   → English bm25s sparse weights (unchanged) → publish

SERVICES: app · search-service (thin) · ingest worker · RDS pgvector · Bedrock (Cohere embed + rerank)
  — NO new self-hosted service, in either environment.
```

## 7. Ingestion upgrade (worker stages — parallel track, mostly one-shot)

- **`parse.py` → Gemini API** (markdown + layout JSON, retained durably); keep pypdf text as the **validation oracle**.
- **Validation sub-step:** char-overlap + **numeric-token equality** + length ratio → fail routes to `needs_review` (existing machinery).
- **`embed.py` chunking → heading-aware** over parsed markdown; store `char_start`/`char_end` + `heading_path` (fixes the `find()` page-attribution bug).
- **Per-chunk context line** (piggyback the summarize LLM pass), prepended to the indexed text (Anthropic contextual-retrieval pattern; benefits dense + the English sparse copy).
- Dense embed calls **Bedrock embed-v4**; **sparse weights are the existing English `bm25s` path — unchanged.**
- Do **not** rebuild doc-level enrichment — `summarize.py` + `classify.py` + committed LLM-metadata extraction cover it.

## 8. Data-model changes (raw-SQL migrations; `synchronize=false`)

1. **Dense index for the new model:** `CREATE INDEX ... USING hnsw ((embedding::vector(1536)) vector_cosine_ops) WHERE embedding_model = 'cohere-embed-v4';` `embed.py` writes `embedding_model='cohere-embed-v4'`, `dimension=1536`. Keep the 3-small index until cutover; drop after.
2. **Sparse:** **no change** — English `bm25s` → `document_chunks.sparse`; `keyword_vocab`/`keyword_corpus_stats` retained.
3. **Parser artifacts:** `document_texts.parsed_markdown text` + layout JSON to S3 via `document_texts.layout_s3_key text`. Keep `full_text` (pypdf) as the validation oracle.
4. **Chunk provenance:** ensure `document_chunks` has `char_start`/`char_end` + `heading_path` (add if absent).
5. **Validation score:** persist per-doc validation result (jsonb) for the review queue / corpus-health surface.

## 9. Per-query latency — budget

| Hop | Estimate | Notes |
|---|---|---|
| Dense encode (Bedrock, cross-region) | ~100–250 ms | short query; cross-region adds a small hop |
| Sparse encode (English bm25s, in-proc) | ~5–20 ms | unchanged, cheap |
| Postgres ANN + sparse lookup | ~20–80 ms | RDS |
| **Rerank (Bedrock Cohere Rerank)** | **~400–700 ms** | dominant term; scales with candidate count → keep ~50–100 |
| Fusion + assembly | ~30–80 ms | |
| **End-to-end** | **~0.6–1.1 s** | two Bedrock RTTs (encode, rerank) + Postgres |

**Levers:** candidate-set size before rerank (biggest — reduce from the current cite `top_n=1000`), and cross-region hop (confirm the closest Bedrock region). No self-hosted load-test needed for v1. Measure end-to-end against the current path once wired.

## 10. Implementation plan — phased

### Phase A — Golden set (BLOCKED on staffing; NON-BLOCKING)
50–100 judged queries (en/zh/es/pt × policy/scientific, incl. cross-lingual). **Interim gate for all phases: the non-English smoke set (commit `1f8092d`) + hand spot-checks.** When labels land, re-run acceptances + formal per-language cite recalibration (`TODO(golden-set)` markers). Also the trigger evaluator for Appendix A (does multilingual sparse close a measured non-English exact-match gap?).

### Phase B — Retrieval substrate
- **B1 — Dense → Cohere embed-v4 (Bedrock).** Swap the embedding call in `embed.py` (ingest) and the query-side dense encode to Bedrock; store `embedding_model='cohere-embed-v4'`/`dimension=1536`; add the scoped HNSW index; re-embed; per-collection cutover via `collections.embedding_model_version`; keep 3-small rows until validated. Wire Bedrock IAM + cross-region inference. **PAUSE for review before the full-corpus re-embed cutover.** Acceptance (interim): retrieval quality on the smoke set ≥ current baseline on zh/es/pt; `/query` shape unchanged.
- **B2 — Rerank → Cohere Rerank 3.5 (Bedrock).** Replace the in-process `OnnxReranker` (`main.py:437-458`) with a Bedrock Rerank client for **both** cite and answer modes; reduce the candidate set (~50–100) before the call; **re-derive `cite_logit_floor` → a 0–1 relevance-score threshold + tiers** (conservative + smoke set; `TODO(golden-set)`). Acceptance: cite mode surfaces zh/es/pt docs it previously dropped; end-to-end latency within §9; `/query` shape unchanged.

### Phase C — Ingestion upgrade (parallel; §7)
Gemini parse + validation + retained artifacts + heading-aware chunking + offsets + context line; dense embed via Bedrock; English sparse unchanged.

### Phase D — Re-ingest the 169 migrated docs
Batch re-ingest through the upgraded pipeline (they bypassed the worker originally). Acceptance: all have Cohere dense + parsed markdown + validation scores.

### Phase E — English-display surface
Render results via `title_en`/`summary_en` + labeled native passage; English answer synthesis; no query translation.

## 11. Constraints (from CLAUDE.md + infra)
- Migrations raw SQL via `queryRunner.query`; `synchronize=false`; pgvector `vector`/`sparsevec` not TypeORM-native.
- Write ownership: Python worker owns `document_chunks`/`document_texts`/`document_summaries`/`keyword_vocab`; never touch `document_tags` `source='human'`/`'external'`.
- Preserve `/query` `QueryRequest`/`QueryResponse` shape (internals/threshold values change; fields don't).
- **Bedrock access:** IAM role for the search-service + worker tasks to invoke Bedrock (embed-v4 + Rerank); cross-region inference profile for us-east-2. No new ECS service/terraform for a self-hosted model.
- Never edit `.env`/`search-service/.env`/`terraform/` for local values. Local prod build `npx next build --webpack`; conventional commits, no `Co-Authored-By`.

## 12. Open questions
1. **Dense A/B:** Cohere embed-v4 (default) vs Gemini Embedding 2 (challenger) when the golden set unblocks.
2. **Bedrock region/cross-region inference** for us-east-2 → embed-v4 + Rerank 3.5; confirm profiles + latency.
3. **Multilingual sparse trigger:** what golden-set signal (non-English exact-match recall gap) justifies building Appendix A.
4. **Golden-set labeling** — blocked on staffing; interim smoke-set gate.

## 13. Risks
| Risk | Mitigation |
|---|---|
| Rerank threshold behavior changes (0–1 vs logits) | Re-derive conservatively on the smoke set; `TODO(golden-set)` for per-language recalibration. |
| Cross-region Bedrock latency | Confirm nearest region/inference profile; measure; candidate-set size is the main lever. |
| Deferring multilingual sparse hurts non-English exact-match | Evidence-gated: the golden set measures it; Appendix A is the pre-designed build if proven. |
| Dense re-embed regressions | Per-row `embedding_model`/`dimension` coexistence; keep 3-small until validated; PAUSE before cutover. |
| Bedrock as a dependency (availability/quota) | Bedrock is in-AWS/IAM; set quotas/alarms; dense degrades to cached/3-small during incident if needed. |

## 14. Appendix A — Evidence-gated Phase 2: multilingual learned sparse (deferred)

**Build only if** the golden set shows a measured **non-English exact-term recall gap** (zh→zh / es→es keyword/name matches that dense + rerank miss). Pre-designed so it's not lost:

- **Component:** a dedicated always-warm **CPU inference service** (separate ECS task, private in-VPC, **one per environment**) hosting **BGE-M3** for learned-sparse weights. Reranker stays on Bedrock (Cohere Rerank).
- **Tooling note:** BGE-M3 *sparse* is not cleanly served by TEI/Infinity (Infinity: "bge-m3, no sparse"; TEI `/embed_sparse` targets SPLADE) → serve via a **custom FastAPI wrapper around `FlagEmbedding` `BGEM3FlagModel`** (returns `lexical_weights`), CPU, INT8, models baked into the image.
- **Wiring:** doc-side weights at ingest (worker → service), query-side one forward pass (search-service → service), stored in `document_chunks.sparse` (replacing the English `bm25s` weights for the multilingual lane); degradation contract (svc down → dense+rerank only).
- **Cost:** ~$70–150/mo **per environment**; plus the brittleness/ops of a self-hosted service. This is the price of non-English exact-term matching — pay it only when evidence shows the gap.

## 15. Sources
External (2026-07-07): [Cohere embed-v4 on Bedrock](https://aws.amazon.com/about-aws/whats-new/2025/10/coheres-embed-v4-multimodal-embeddings-bedrock/) · [Cohere Rerank 3.5 on Bedrock](https://aws.amazon.com/blogs/machine-learning/cohere-rerank-3-5-is-now-available-in-amazon-bedrock-through-rerank-api/) · [Bedrock rerank supported regions](https://docs.aws.amazon.com/bedrock/latest/userguide/rerank-supported.html) · [Rerank 3.5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-cohere-rerank-3-5.html) · [Gemini Embedding 2 specs](https://tokencost.app/blog/gemini-embedding-2-pricing) · [MMTEB rankings Apr 2026](https://awesomeagents.ai/leaderboards/embedding-model-leaderboard-mteb-april-2026/) · [MTEB-PT (arXiv 2607.04581)](https://arxiv.org/html/2607.04581v1) · [BGE-M3 sparse (Zilliz)](https://zilliz.com/learn/bge-m3-and-splade-two-machine-learning-models-for-generating-sparse-embeddings).
Internal: `archive/2026-06-09-multilingual-and-collections.md`; `2026-06-09-askwri-document-management-design.md` §10; `docs/research/2026-06-10-multilingual-retrieval-design-research.md`; worker `search-service/worker/stages/*`; query side `search-service/app/{main,pg_store,config,sparse_keyword}.py`; schema `src/db/migrations/1781280000000-Migration.ts`; infra `terraform/environments/{qa,production}.tfvars`.
