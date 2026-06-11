# Keyword-lane replacement — design note (evidence-gated)

**Date:** 2026-06-11
**Status:** Ready for review — all baseline evidence measured; awaiting sign-off on the
recommendation before an implementation plan is written
**Branch:** `keyword-lane-replacement` (off local `qa`)
**Scope guard:** `/query` request/response contract (`QueryRequest`/`QueryResponse` in
`search-service/app/main.py`) is untouched by every option below. Retrieval tuning (RRF
weights, reranker, thresholds) stays out of scope.

---

## 1. Problem

The hybrid retriever's two lanes have different residency:

| Lane | Residency | `status='searchable'` filtering |
|---|---|---|
| Dense | Postgres (pgvector), SQL per query | per-query (instant consistency) |
| BM25 | **In service memory**, built at boot / `POST /reindex` | only as of last build (stale until rebuild) |

Costs of the in-memory lane, as built:

- **Staleness choreography.** Withdraw/promote (admin UI) and worker publish each fire a
  best-effort `POST /reindex` (`src/lib/search-reindex.ts`,
  `search-service/worker/stages/publish.py`). Until it succeeds, withdrawn docs still
  surface in keyword results and promoted docs are missing.
- **Synchronous rebuild that overruns its caller.** Phase 2 measured `/reindex` at ~540s on
  the full corpus — far past the app tier's 120s timeout, so the admin UI effectively always
  shows the staleness warning. (Re-measured today: see §4.4 — the steady-state number is far
  smaller, but the conclusion stands.)
- **State cleared during rebuild.** `service_state["bm25_retriever"] = None` while
  reloading: keyword lane vanishes mid-rebuild (single-flight 409 lock added in Phase 2, but
  the clear remains).
- **Horizontal-scaling hole.** `/reindex` is a POST to one instance. At
  `search_service_desired_count > 1` (terraform already wires autoscaling with
  `ignore_changes = [desired_count]`), the load balancer refreshes ONE task; every other
  replica stays stale until restart. The current scheme structurally caps the service at one
  replica.
- **Boot-time coupling.** Every boot rebuilds the BM25 index from all searchable chunks
  (~30k rows), so service cold-start scales with corpus size.

A Postgres-resident keyword lane makes withdraw/promote instantly consistent (one UPDATE),
deletes the choreography in both services, and makes the search-service stateless for
keyword retrieval.

## 2. What exactly the current lane is (verified in code, 2026-06-11)

- `llama-index-retrievers-bm25` 0.7.1 over **bm25s 0.3.0**, method `lucene` (default).
- Tokenization (index & query side identical): lowercase, token pattern `(?u)\b\w\w+\b`,
  **English** stopwords, **English** Snowball stemmer (PyStemmer).
- Indexes `node.get_content(metadata_mode=MetadataMode.EMBED)` — i.e. chunk text **plus the
  metadata header** (title/authors/year/...). Any replacement must index the same string.
- zh behavior: CJK has no spaces, so `\w\w+` makes each inter-punctuation run a single
  token. Keyword matching for zh is effectively exact-run matching (known limitation,
  documented in the multilingual research note §1.1). The corpus stores zh chunks as
  Simplified (OpenCC t2s at ingest).
- Query expansion (`expand_query_conservative`) is applied to the BM25 leg only, **before**
  tokenization — string-level, unaffected by any residency change.
- Scoring: bm25s precomputes the **impact weight of every (token, doc) pair** at index time
  into a CSC sparse matrix (`bm25.scores`); query scoring is
  `score(doc) = Σ_{t ∈ query tokens} weight[t, doc]` (`get_scores_from_ids`, bm25s
  `__init__.py:575`). With method `lucene` there is no non-occurrence correction.
  **This is exactly a sparse inner product** between a per-chunk weight vector and a query
  token-count vector — the fact option (b) builds on.
- RRF fusion consumes only the **rank order** of the lane (k=60), not score magnitudes;
  ties in BM25 scores resolve by corpus position (`corpus_order` reproduces this).

## 3. Constraints (verified)

| Constraint | Status |
|---|---|
| RDS PG16 extensions | `vector` 0.8.2, `pg_trgm` 1.6, `unaccent` 1.1, `pg_bigm` 1.2 supported; **zhparser, pg_jieba, pg_search (ParadeDB), rum NOT available** (AWS RDS PG16 extension list, checked 2026-06-11) |
| Local docker (`askwri-pg`, PG 16.14) | `vector` 0.8.2 installed; `pg_trgm`/`unaccent` available; **`pg_bigm` NOT in the image** — any pg_bigm-based design can't be locally evaled without a custom image |
| FTS configs available (PG16) | `english`, `spanish`, `portuguese`, `indonesian` exist; **no CJK segmentation** — `to_tsvector('simple', <zh>)` produces whole inter-punctuation runs (verified: one lexeme per run), i.e. the same blindness as today's bm25s tokens |
| `document_chunks.sparse sparsevec` | exists since Phase 0 (migration `1781280000000`), **0/30,526 populated** — schema anticipated this lane |
| Write ownership | Python owns `document_chunks` (raw SQL); a tsvector or sparsevec backfill belongs to the Python side (worker/scripts), not the app tier |
| Corpus (local `qa` db) | 169 docs / 30,526 chunks: en 22,065 (136 docs), zh 5,514 (19), es 1,839 (10), pt 1,108 (4) |
| Reversibility | all options below implement behind `KEYWORD_BACKEND=memory\|<new>` in `search-service/app/config.py`, mirroring `RETRIEVAL_BACKEND` |

Data caveat found while building the smoke set: 3 documents labeled `zh`
(`2022_toward-credible-transport-carbon-dioxide_3778`/`_5852`,
`2023_assessing-low-carbon-strategies-of-local_2130`) contain **English** extracted text.
They're excluded from smoke targets; flagged for the ingestion/langID workstream.

## 4. Evidence (baseline, postgres backend, local)

> Environment: local M-series Mac, docker Postgres, ONNX reranker (un-quantized graph).
> All comparisons are same-box before/after; absolute latencies are not production numbers
> (see §8, serving observation).

### 4.1 `eval:cite` baseline (measured 2026-06-11)

**P .1943 / R .8701 / F1 .3039 — 5/11 passed, 11/11 queries clean.**
Report: `evaluation/results/eval-report-1781206354004.json`. Per-query end-to-end
latency p50 269s / p95 475s (local CPU, reranker-dominated — see §8; only the
keyword-lane retrieval slice changes in this workstream).

Notably below the Phase 1 reference (P .2442 / R .8450 / F1 .3679, 8/11) — precision
drifted as the corpus changed, which is exactly why the gate uses a fresh same-day
baseline, not historical numbers. Both backends are compared against THIS run.

(Measurement notes: the first attempt was invalidated by undici's default 300s fetch
timeout aborting q7–q11 mid-rerank and cascading — fixed via a 30-min dispatcher timeout
in `evaluation/lib/service-client.ts`, plus per-query checkpointing in both runners and a
detached suite runner, `evaluation/run-baseline-suite.sh`. A stale pre-fix eval process
also wrote `eval-report-1781204612065.json` (7/11 errored against a dead service) — that
file is junk; ignore it.)

### 4.2 `eval:answer-retrieval` baseline (measured 2026-06-11)

**Chunk P .437 / R .304 / F1 .357 · chunk-adjacent F1 .465 · doc-level P .888 / R .874 /
F1 .871** (9/9 queries clean). Report:
`evaluation/results/answer-retrieval-1781207582701.json`.

### 4.3 Non-English smoke set baseline (measured 2026-06-11)

`evaluation/non-english-smoke.json` (16 hand-verified zh/es/pt queries, term occurrence
checked against `document_chunks.text`; smoke test, **not** a golden set) + runner
`evaluation/run-non-english-smoke.ts` (rerank=false; lane-level target ranks). Results:
`evaluation/results/non-english-smoke-baseline-1781207606045.json`.

| Lane | zh (7) | es (5) | pt (4) |
|---|---|---|---|
| BM25 (current, in-memory) | **0/7 found** | 5/5 @ rank 1 | 4/4 @ rank 1 |
| Dense (pgvector) | 7/7 @ rank 1 | 5/5 @ rank 1 | 4/4 @ rank 1 |
| Fused docs | 7/7 @ rank 1 | 5/5 @ rank 1 | 4/4 @ rank 1 |

**The current keyword lane contributes nothing for zh queries** — whole-run tokens never
match — and the dense lane carries them. So constraint 3 ("don't silently regress
non-English keyword matching") means: es/pt must stay at rank 1 in the keyword lane, and
zh must not get *worse than absent*. Option (b) preserves zh tokenization verbatim, so
its zh behavior is identical by construction.

### 4.4 `/reindex` duration (postgres mode) — re-measured

**HTTP 200 in 18s** (steady state, models warm, idle box;
`evaluation/results/reindex-timing.json`). The Phase 2 measurement of ~540s does **not**
reproduce; boot-time rebuild today was ~40s–7min depending on concurrent load. Honest
reading: the "9-minute reindex" framing in the session prompt overstates the steady-state
cost — the rebuild is environment-sensitive, not intrinsically slow. This strengthens
option (d)'s surface case; the case against (d) is architectural (§5d), not the timer.

### 4.5 Consistency demonstration (baseline behavior, measured)

Withdrew `2022_guia-de-entornos-caminables-seguros_2940`
(`UPDATE documents SET status='withdrawn'`), then queried "entornos caminables seguros"
with no reindex:

- BM25 lane: withdrawn doc still **rank 1** (stale index)
- Dense lane: correctly absent (per-query SQL filter)
- **Final fused docs: the withdrawn doc leaks into user-facing results**

(Doc restored afterward; BM25 index unchanged throughout — which is the point.) Under any
Postgres-resident option the keyword lane shares the dense lane's per-query status filter
and the leak is structurally impossible. The candidate implementation must repeat this
demo with `KEYWORD_BACKEND=sparse` showing immediate exclusion/inclusion.

### 4.6 BM25-as-sparsevec score parity (offline prototype)

`search-service/scripts/sparse_parity_check.py`: builds the exact boot-time
BM25Retriever, exports the bm25s impact matrix as per-chunk sparse vectors, and checks
that inner products against query token-count vectors reproduce the production
`bm25.retrieve()` scores on all 10 golden + 16 smoke queries.

**26/26 queries score-identical** (10 golden + 16 smoke; atol 1e-3 vs the production
`bm25.retrieve()` path). Feasibility numbers on the current corpus:

- vocab size (= sparsevec dimension): **184,395** (well under sparsevec's ~1e9 dim limit)
- nnz per chunk vector: **max 194, mean 127** — far under the 16k storage limit and under
  the 1k HNSW limit, so an ANN index stays available if the corpus ever needs it (not
  needed at 30k rows: exact scan ⇒ zero recall loss)
- corpus tokenize + index build: 6.6s (the backfill's dominant cost is just writing rows)
- zh queries match **0** vocab tokens — reproducing the baseline zh blindness exactly
  (§4.3), i.e. zh behavior is preserved verbatim, as designed

(Method note: the first run of this script reported 0/26 — its *reference* path was wrong,
scoring with token ids from a fresh tokenizer vocabulary instead of the corpus vocabulary.
Fixed to call the exact production `bm25.retrieve()` path. Recorded here because a
parity-check harness that itself needs debugging is worth being honest about.)

## 5. Options

### (a) Postgres FTS (`tsvector` + GIN, per-language regconfig)

Per-language `to_tsvector('english'|'spanish'|'portuguese'|'indonesian', text)`; zh falls
back to `simple` (whole-run lexemes — same zh blindness as today) or `pg_bigm` (not in the
local image; bigram precision is mediocre) or app-side jieba feeding `'simple'` (new
dependency, changes zh behavior = out-of-scope tuning).

- **For:** native Postgres, standard GIN indexing, no vocab state, instant consistency.
- **Against:** `ts_rank`/`ts_rank_cd` is **not BM25** — no IDF, no document-length
  normalization comparable to BM25. The English lane (87% of queries' target mass) gets a
  different ranking function, so eval parity is a genuine roll of the dice, not an
  engineering guarantee. Stemming/stopwords also differ slightly from bm25s
  (Snowball-but-different-pipeline, different stopword list), and the metadata-header
  convention must be replicated manually. Per-language `regconfig` plumbing (column or
  expression indexes per language) is the most schema-invasive option.
- **Eval risk: high.** Cannot be made score-compatible with the current lane even in
  principle.

### (b) BM25-as-sparse-vector in `document_chunks.sparse` ⭐ recommended

Precompute each chunk's bm25s impact-weight vector (the exact CSC column bm25s already
builds in memory today) and store it as `sparsevec`. Query path: tokenize the (expanded)
query with the same bm25s tokenizer → map tokens to vocab ids (small `keyword_vocab`
table) → build a sparse count vector → `ORDER BY sparse <#> :qvec LIMIT 500` with the same
`status='searchable'` join as the dense lane.

- **Score-exact by construction:** same tokenizer, same stopwords/stemmer, same metadata
  header, same impact weights ⇒ identical scores and (with `corpus_order` tie-break)
  identical rankings to today's lane. The eval gate verifies this rather than gambles on it.
- **zh behavior preserved verbatim** (same tokens) — constraint 3 satisfied by identity,
  not by argument. (zh stays as bad as today; improving it is the multilingual workstream's
  D3 decision, and `sparsevec` is exactly the column that work expects to use.)
- **Instant lifecycle consistency:** the keyword query joins on `status='searchable'`
  per query, like the dense lane. Withdraw/promote = one UPDATE. The entire reindex
  choreography (app tier + worker + boot build) is deleted.
- **RDS-safe:** pure pgvector 0.8.2 (`sparsevec` + inner product), already on RDS and in
  the local image. Exact scan at 30k rows (no ANN index needed ⇒ no recall loss; HNSW
  sparsevec available later if the corpus grows 100×, nnz/vector ≤ ~350 today, limit 1,000).
- **Costs / honest caveats:**
  - **Frozen corpus statistics.** BM25 weights embed IDF/avgdl of the corpus snapshot. New
    docs are weighted with the stats current at their embed time; corpus-wide stats drift
    as docs are added until a refresh recomputes vectors (~40s of tokenization for the
    whole corpus, run async by the worker — no serving impact, no correctness dependency:
    lifecycle consistency never depends on the refresh, only weight freshness does).
    Today's lane "solves" this by rebuilding everything on every change — the refresh job
    is the same operation made async and decoupled from correctness.
  - **Vocab table:** new docs can contain new tokens; the embed stage upserts vocab rows
    (token → id) before writing vectors. OOV query tokens score 0 (identical to bm25s).
  - **Backfill:** one script populates `sparse` for 30,526 chunks (~minutes); worker embed
    stage (`worker/stages/embed.py`) writes `sparse` alongside `embedding` for new docs.
- **Eval risk: minimal** (parity is mechanical; §4.6 verifies offline before the service
  even changes).

### (c) pg_trgm similarity as the keyword lane

Trigram similarity is string fuzziness, not term-relevance ranking: no TF, no IDF, and
`similarity()` normalizes by the trigram-set union, so a 25-word query against a 400-token
chunk produces uniformly tiny, poorly-ordered scores. It's the right tool for typo-tolerant
title lookup, the wrong primitive for a retrieval lane. (As a zh-only assist it would
actually beat whole-run tokens — but that's multilingual tuning, explicitly out of scope.)
**Rejected as primary lane; no implementation.**

### (d) Do nothing structural (keep in-memory BM25, soften the edges)

Make `/reindex` build-then-swap (no state clear), debounce it, and accept the staleness
window. bm25s has no incremental update API (immutable CSC matrix) — "incremental" means
full rebuild regardless.

- **For:** smallest diff; steady-state rebuild measured at **18s** today (§4.4), so the
  120s-timeout/staleness-warning problem mostly dissolves on its own — this option is
  more credible than the session prompt's 9-minute framing suggested.
- **Against:** keeps the staleness window and the two-service choreography; keeps boot-time
  scaling with corpus size; and **cannot fix the >1-replica hole** — POST /reindex reaches
  one task, period. The hidden cost isn't the 9 minutes, it's the architecture.

A hybrid (a)+(c)-for-zh was considered and dropped: it inherits (a)'s English ranking risk
AND adds a second mechanism, while (b) achieves the goal with one mechanism and zero
ranking risk.

## 6. Recommendation

**Option (b)**, behind `KEYWORD_BACKEND=memory|sparse` (default `memory` until the eval
gate passes). It is the only option where retrieval parity is a property of the
construction rather than a hope: the decision gate (candidate ≥ baseline, no material
latency regression) reduces to verifying an identity plus measuring a ~30k-row sparse scan.
It deletes all the listed accidental complexity, unblocks >1 replica, and populates the
schema column Phase 0 created for exactly this purpose — which is also the substrate the
multilingual workstream (D3: BGE-M3 lexical weights) expects to reuse.

## 7. If adopted — simplification payoff (remove/no-op)

- `src/lib/search-reindex.ts`; `reindex` field + notices in
  `src/app/api/admin/documents/[id]/status/route.ts`, `src/app/admin/review/page.tsx`,
  `src/app/admin/documents/[id]/page.tsx`
- reindex POST in `search-service/worker/stages/publish.py`
- boot-time BM25 build + rebuild path in `load_from_postgres`;
  `/reindex` endpoint: keep as a cheap no-op returning success (it is consumed nowhere
  after the removals above; deprecate in a later cleanup)
- docs: `docs/document-management.md` §4 gotcha + §11 lifecycle notes

## 8. Flagged observations (out of scope, recorded so they don't get lost)

- **Production reranker serving:** local M-series Mac with ONNX takes ~3 min to rerank a
  500-candidate cite pool; production is one Fargate vCPU (x86) on the **un-quantized**
  ONNX graph (sentence-transformers warns it defaults to `model.onnx`, ignoring
  `model_qint8_avx512_vnni.onnx`). Production cite latency is plausibly worse than local.
  Cheap fix when the retrieval workstream takes it: pin the quantized file via
  `model_kwargs={"file_name": ...}` and/or rerank a smaller pool.
- **3 zh-labeled docs with English text** (§3) — ingestion/langID workstream.
- **2 "Bahasa" docs indexed as `en`** (known, documented in document-management.md §7).

## 9. Process from here

1. Sign-off on this note (you are here).
2. Implementation plan via superpowers:writing-plans; execute via
   superpowers:subagent-driven-development.
3. Eval gate: rerun §4.1–4.3 with `KEYWORD_BACKEND=sparse`; adopt only if candidate ≥
   baseline and latency is not materially regressed; merge `--no-ff` to local `qa`
   (no push).
