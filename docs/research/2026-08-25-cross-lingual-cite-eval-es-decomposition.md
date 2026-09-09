# Cross-Lingual Cite Eval — es 0/8 Decomposition

**Date:** 2026-08-25
**Question:** The Cite eval shows Spanish-language expected documents lagging English and Chinese (Cite-01: en 70%, zh 100%, **es 0%**; Cite-02: en 84%, zh 92%, es 62%). Is this a Spanish retrieval problem we should fix?

**Answer:** No — not as the screenshot presents it. The 0/8 is real and reproduces on QA, but it is not a Spanish retrieval failure. It decomposes into shared broad-query failures, a debatable golden-set label, and one genuine cross-lingual miss. There is no basis here for a model or pipeline change.

---

## 1. The screenshot reproduces on QA — the gap is real, the interpretation is not

The screenshot came from a **local** eval (`target: http://127.0.0.1:3000` in `evaluation/results/evalset-evalset_cite_01-1787247014614.json`). Local data is not reflective of QA (local corpus = 178 docs, only 1 of 4 es expected docs present, `SPARSE_EN_HANDLES` not set in any local env file). So the eval was re-run against the QA gateway:

```
EVAL_TARGET=https://qa.askwri-app.org npx tsx evaluation/run-evalset.ts \
  evaluation/eval-review/evalsets/evalset_cite_01.json --mode cite
```

Per-language breakdown (by expected-document language, with multiplicity, matching the screenshot's method — 87 = 77 en + 2 zh + 8 es):

|         | Screenshot (local) | QA (2026-08-25) |
|---------|-------------------|-----------------|
| Cite-01 en | 54/77 (70.1%) | 53/77 (68.8%) |
| Cite-01 zh | 2/2 (100%) | 2/2 (100%) |
| **Cite-01 es** | **0/8 (0.0%)** | **0/8 (0.0%)** |
| Cite-02 en | 70/83 (84.3%) | 69/83 (83.1%) |
| Cite-02 zh | 11/12 (91.7%) | 9/12 (75.0%) |
| Cite-02 es | 5/8 (62.5%) | 5/8 (62.5%) |

The es gap is real on QA, where all 4 unique es docs are present, `SPARSE_EN_HANDLES=true` is set on the ingestion worker (`askwri-app-qa-ingestion-worker:41`), and config is prod-real. The gap is not a local artifact.

(One `id` row appears in the raw breakdown — `2025_panduan-pelaksanaan-inventarisasi-pohon-perkotaan_4324`, Bahasa Indonesia, added in the 2026-08-17 corpus refresh. n=1, and it was retrieved. It is noise and excluded from the comparison.)

---

## 2. Where the es docs actually die — observed on QA, not theorized

The search-service `/query` endpoint accepts `return_intermediate_results: true`. The gateway (`src/app/api/llamaindex/route.ts`) spreads `...options` into the upstream request, so this passes through QA. The response's `debug.lane_ranks` is keyed in fused-score order (index = fused rank), with per-node `dense` / `sparse` / `topic_dense` ranks. The reranker only sees the top **100** fused chunks (`rerank_candidates = 100`, `search-service/app/config.py:194`); the un-reranked tail is dropped (`bedrock_rerank.py`: "un-reranked tail is DROPPED").

Tracing the es docs on the missed queries:

| Query | es doc | dense | sparse | topic_dense | best fused rank | outcome |
|---|---|---|---|---|---|---|
| q10 "urban finance since 2020" | `_3765` | — | 68 | — | **155** | >100, never reranked |
| q10 | `_0152` | — | — | 44 | 352 | >100, never reranked |
| q10 | `_0070` | — | — | 55 | 396 | >100, never reranked |
| q1 "land value capture" | `_0152` | — | — | — | not in top-500 | dies before fusion |
| q5 "micromobility" | `_0030` | — | — | — | not in top-500 | dies before fusion |
| **d4 "financing mechanisms for public transport"** | **`_3765`** | **36** | — | **12** | **7** | **retrieved** |

**The es docs do not reach the reranker on the missed queries.** They die at the rerank candidate cut (fused rank > 100) or earlier (not in any lane's top-500). The cross-lingual reranker never gets a chance to rescue them.

On d4, where dense finds `_3765` at rank 36, it is retrieved successfully — proving the cross-lingual dense + rerank path works when the query is specific enough to surface the doc into the candidate pool.

---

## 3. The es 0/8 decomposes — most of it is not a Spanish problem

Per-query, per-language breakdown of Cite-01 on QA:

| case | en | zh | es | all | query |
|---|---|---|---|---|---|
| q1 land value capture | 3/4 | 1/1 | 0/1 | 4/6 | "What have we published on land value capture?" |
| q5 micromobility | 7/10 | 1/1 | 0/1 | 8/12 | "How can cities implement micromobility solutions?" |
| q10 urban finance since 2020 | **2/7** | — | 0/3 | 2/10 | "urban finance since 2020" |
| q11 urban finance exclude ebuses | **1/8** | — | 0/3 | 1/11 | "urban finance – exclude ebuses" |
| q2-q4, q6-q9 | varies | — | — | varies | (no es expected) |

**6 of 8 es "misses" are on q10 and q11**, where English docs also fail (en 2/7 = 28% and 1/8 = 12%). These are broad, hard queries where the whole retrieval fails — not Spanish-specific failures. The per-language breakdown attributes them to "es" only because the expected documents happen to be the Spanish-language cross-lingual counterparts that were added to those queries.

Decomposition of the 8 es misses:

| count | type | evidence |
|---|---|---|
| 6 | **shared broad-query failure** | q10/q11: en also 12–28% recall on the same query |
| 1 | **debatable golden-set label** | q5 `_0030` "Motorcycle Safety" for "micromobility" — evalset note: `"NEEDS SME REVIEW: motorcycles are a debatable fit for 'micromobility'"` |
| 1 | **genuine cross-lingual miss** | q1 `_0152` "Federal Actions for Urban Planning" (es body on land value capture) not in any lane's top-500 for "land value capture" |

---

## 4. Why the one genuine miss happens — and why it is not a model problem

`_0152` ("Acciones Federales de Planeación Urbana") is a Spanish-language WRI report on Mexican federal urban planning, with substantial content on land value capture ("recuperacion de plusvalias"). Its English handle (verified in QA: all 7 stemmed title tokens — `analysi`, `financ`, `mechan`, `sustain`, `public`, `transport`, `urban` — are present in its summary chunk's sparse vector) is the *title_en*: "Federal Actions for Urban Planning: Towards Better Cities." That title is topically generic — it does not match "land value capture."

For the query "What have we published on land value capture?":

- **Sparse lane** is English-only by construction (English Snowball stemmer, English stopwords, token pattern `(?u)\b\w\w+\b` — `search-service/app/sparse_keyword.py`). The English handle matches the generic English title, not the Spanish body content where "recuperacion de plusvalias" lives. No sparse match.
- **Dense lane** (cohere-embed-v4, multilingual) could bridge English query → Spanish body. But "land value capture" is a broad topic; ~500 English documents on urban planning, finance, and housing are semantically closer to the query than `_0152`'s Spanish body, so `_0152` does not make the dense top-500.
- The doc never enters fusion, never reaches rerank.

This is the documented limitation of the sparse handle mechanism itself: `search-service/app/sparse_handles.py` injects the English *title* (and, for summary chunks, the English *long summary*) into sparse tokens — it does not and cannot translate the Spanish *body* where the topical signal lives. The handle makes Spanish docs findable by *title-shaped* English queries; it does nothing for *topical* English queries against Spanish bodies.

`_0030` (q5) is the same shape: "Motorcycle Safety and Urban Road Infrastructure" does not match "micromobility" by title, and the Spanish body is not bridged by sparse.

---

## 5. The zh advantage is a corpus artifact, not a retrieval feature

zh docs are retrievable by English queries because WRI's Chinese PDFs ship with **English title pages baked into the body text** (verified on QA: `2019_zhuzhou-complete-street-design-manual_2976` chunk 0 contains `ZHUZHOU COMPLETE STREET DESIGN MANUAL` and `WORLD RESOURCES INSTITUTE` in the chunk text). Both the sparse lane and the dense/rerank lanes see this English text.

es/pt/id WRI PDFs do not carry English title pages in the body. The English handle lives *only* in sparse tokens, never in chunk text (`sparse_handles.py`: "handle text must never reach the stored chunk text" — because injecting it would change dense embeddings and force a re-embed). So the reranker sees Spanish text for es docs, English text for zh docs.

This asymmetry is real, but it is **not the cause of the 0/8** — the es docs die before the reranker sees anything (Section 2). The zh advantage matters on queries where the English title is the matching signal; it is irrelevant to the q1/q5 topical misses where the title is generic.

---

## 6. What this means

**There is no fix to make based on this screenshot.**

- The pipeline is doing what it is designed to do. The cross-lingual dense + rerank path works (d4 retrieves `_3765` via dense rank 36).
- 6 of 8 es "misses" are shared broad-query failures misattributed to a language axis.
- 1 of 8 is a debatable golden-set label.
- 1 of 8 is a genuine cross-lingual topical miss — n=1 is not a basis for a model or pipeline change.

Before any fix is on the table, the eval itself needs work:

1. **Separate "hard query" from "Spanish miss."** The per-language breakdown conflates them. A query-level failure analysis (which q10/q11 plainly are — en 12–28%) should not count toward a language signal. The breakdown should report per-language recall *conditional on the query not being a global failure*, or report query-level and language-level signals separately.
2. **Resolve the `_0030` relevance flag.** The evalset note says `"NEEDS SME REVIEW: motorcycles are a debatable fit for 'micromobility'"`. If motorcycles are not micromobility, remove `_0030` from q5 — it is a false negative in the golden set, not a retrieval bug.
3. **Get n up.** One genuine cross-lingual miss is not actionable. `evaluation/cross-lingual-en.json`'s `en-body` class (12 queries authored to avoid title-vocabulary circularity, covering all 12 non-English QA documents exactly once) is the right instrument for measuring genuine cross-lingual topical retrieval. It has not been run on QA as part of this investigation.

---

## 7. What was ruled out (and why)

| Hypothesis | Status | Evidence |
|---|---|---|
| `SPARSE_EN_HANDLES` is off on QA | **False** | Set on `askwri-app-qa-ingestion-worker:41`; QA es doc sparse vectors contain all 7 English title tokens |
| The index-side handle is broken | **False** | Decoded `_3765` summary-chunk sparse vector on QA — `analysi`, `financ`, `mechan`, `sustain`, `public`, `transport`, `urban` all present |
| The reranker floor (`cite_logit_floor = 0.09`) drops Spanish | **False** | The es docs never reach the reranker — they die at the fused-rank-100 candidate cut or before fusion |
| Cohere Rerank v3.5 can't score cross-lingually | **Untested, and moot** | The reranker is multilingual; on d4 it scored `_3765` (retrieved via dense) successfully |
| The 0/8 is a local artifact | **False** | Reproduces on QA (Section 1) — local was unreflective, but the gap is real |
| zh wins because its chunk text contains English | **Partly true, not the cause** | zh chunk text does contain English title pages (corpus artifact), but the es misses die before the reranker sees text |

---

## Evidence anchors

- **QA eval re-run results:** `evaluation/results/evalset-evalset_cite_01-1787685478323.json`, `evaluation/results/evalset-evalset_cite_02-1787685507987.json`
- **Failure-stage trace (QA):** `debug.lane_ranks` from `POST https://qa.askwri-app.org/api/llamaindex` with `return_intermediate_results: true` for q1, q5, q10, d4
- **QA env:** `aws ecs describe-task-definition --task-definition askwri-app-qa-ingestion-worker:41` → `SPARSE_EN_HANDLES = true`; `askwri-app-qa-search-service:169` → neither `SPARSE_EN_HANDLES` nor `QUERY_TRANSLATION_*` set (defaults)
- **QA DB:** `documents`, `document_chunks`, `keyword_vocab` via `./scripts/with-remote-env.sh qa psql`; decoded `_3765` summary-chunk sparse vector for English handle tokens
- **Code:** `search-service/app/sparse_handles.py` (handle mechanism + "never reach chunk text"), `search-service/app/sparse_keyword.py` (English-only tokenization), `search-service/app/bedrock_rerank.py` (rerank candidate cut, tail dropped), `search-service/app/config.py:194` (`rerank_candidates = 100`), `search-service/app/config.py:222` (`cite_logit_floor = 0.09`), `src/app/api/llamaindex/route.ts` (gateway passes `return_intermediate_results` through `...options`)
- **Evalsets:** `evaluation/eval-review/evalsets/evalset_cite_01.json` (q5 `_0030` "NEEDS SME REVIEW" note; q10/q11 es additions), `evaluation/eval-review/evalsets/evalset_cite_02.json`, `evaluation/cross-lingual-en.json` (`en-body` class)
