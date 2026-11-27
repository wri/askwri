# Where the missing cite_01/cite_02 gold goes

**Date:** 2026-11-27
**Status:** measured diagnostic, no code change
**Path:** all four retrieval stages for every expected document, 24 positive cases
(11 cite_01 + 13 cite_02), 189 expected documents, 219-document QA corpus.
Refs #498, #403, #290.

## Why

The lane ablation left one question open: the unretrieved gold on broad topics (`q1` 4/5,
`q3` 6/8, `q7` 2/4, `q10` 2/10, `q11` 2/11). If those documents were absent from the index
or only reachable through summaries, a doc-level lane would be the lever. This measures
which stage loses them.

## Method

Local search-service at `qa` tip (`b444ff8`), qa RDS via `scripts/with-remote-env.sh`,
Bedrock embed/rerank, service flags as qa (understanding, lanes, sidecar on). Cite preset
params sent explicitly (`vector_top_k=500, bm25_top_k=500, rerank_top_n=500,
fusion_top_k=500, max_results=25`), `return_intermediate_results=true` so every stage's
document list is visible. Each expected document that did not appear in `docs` is classified
by the deepest stage that contained it:

| verdict | meaning |
|---|---|
| `cut_after_rerank` | in the rerank top 100, dropped by the logit floor or the 25-result cap |
| `cut_by_rerank_window` | fused, but outside the rerank top 100 |
| `pooled_but_not_fused` | in the dense or sparse top 500, absent from fusion |
| `not_in_pools` | absent from both 500-wide pools |

**Caveat:** the local sidecar degraded (OpenAI call fails locally), so `variants` is empty in
every case; QA's live pools also carry variant-lane chunks. This diagnostic therefore
understates the candidate pool, and cannot see documents that only a variant would surface.
`q4`'s numbers are the visible symptom of that gap.

## Results

189 expected, 139 returned, **50 missing**:

| verdict | count | share |
|---|---|---|
| `cut_after_rerank` | 28 | 56% |
| `cut_by_rerank_window` | 8 | 16% |
| `pooled_but_not_fused` | 7 | 14% |
| `not_in_pools` | 7 | 14% |

Of the 28 `cut_after_rerank`, **11 were in cases that returned 25 documents** (the cap) and
**17 in cases under 25** (the 0.09 floor). Their rerank ranks: minimum 18, median 62, maximum
100 — the gold is not near the line; it is deep.

- **Summary nodes do not help.** Only **2 of the 50** missing documents had a `_summary`
  chunk anywhere in the pools. A document-summary lane would be building for 2 documents.
- **Pool depth helps only the 7 `not_in_pools`.** Re-run at `vector_top_k=bm25_top_k=3000`:
  6 of the 7 appear (5 in both pools, 1 sparse-only); one
  (`2023_financial-analysis-of-charging-station-fact_2082`) still does not. The deep docs
  would then still have to clear fusion and the rerank top 100.
- **Thresholds buy recall slowly.** Local, cap 25, all-on:

| change | MAP | aR | avg docs |
|---|---|---|---|
| floor 0.09 (shipped) | 54.0 | 77.1 | 19.5 |
| floor 0.05 | 54.7 | 79.9 | 22.0 |
| cap 100, floor 0.09 | 54.5 | 78.6 | 26.2 |

(The absolute MAP is lower than QA's because variants are missing locally; only the deltas
are meaningful.) The 17 floor-cut documents score **below 0.05**, so recovering them means
flooding the list with weak results.

## Conclusion

**The retriever finds the missing gold; the reranker ranks it 26–100, or the floor discards
it.** 44 of 50 are already inside fusion or the rerank window. This is not a query-expansion
gap, not a summary/index gap, and not fixed by caps, floors, or pool depth — each of those
moves recall by a few points while adding weak documents to the user's list.

The remaining lever is reranking quality for broad, amorphous topics (a reranker/model
question, outside query expansion), or accepting that the eval's doc-level relevance is
broader than a top-25 chunk rerank can express. The summary lane hypothesised after the lane
ablation is **not** supported by this data.
