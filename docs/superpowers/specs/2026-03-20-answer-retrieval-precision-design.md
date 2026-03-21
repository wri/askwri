# Answer Mode Retrieval Precision Design

**Goal:** Maximize precision of passages fed to answer synthesis by tightening the retrieval pipeline and adding an LLM relevance filter.

**Architecture:** Two-phase approach. Phase 1 tightens retrieval parameters (alpha, rerankTopN, remove broken normalized threshold). Phase 2 adds a GPT-5.4-nano per-chunk relevance classifier between retrieval and synthesis, replacing the cross-encoder reranker as the primary relevance discriminator.

**Tech Stack:** GPT-5.4-nano (relevance filter), cross-encoder/ms-marco-MiniLM-L-6-v2 (reranker, unchanged), Next.js API route, Python search service.

---

## Problem Statement

The answer mode retrieval pipeline delivers ~60% precision at the synthesis input. For broad research queries ("Are denser cities more sustainable?"), precision drops to 20-30%. The cross-encoder reranker cannot discriminate relevant from irrelevant passages for these queries — relevant and irrelevant score distributions overlap almost completely (medians 2.25 vs 2.07).

Three specific failures:
1. **No absolute relevance signal.** The per-query normalized threshold (0.75) always passes the top ~25% regardless of absolute quality.
2. **Reranker sees too few candidates.** Only top-20 from fusion are reranked; better candidates may exist in positions 21-50.
3. **Keyword noise dominates broad queries.** Equal dense/sparse weighting (alpha=0.5) lets BM25 pull in anything containing common terms like "cities" or "sustainable."

## Calibration Evidence

From `evaluation/results/answer-threshold-calibration-2026-03-20T23-02-15.json` (GPT-5.4 debiased labels, 9 golden queries, 857 labeled chunks):

| Metric | Value |
|--------|-------|
| Relevant score median | 2.25 |
| Irrelevant score median | 2.07 |
| Score IQR overlap | Near-complete |
| Precision@10 (no threshold) | 62% |
| Precision@20 (no threshold) | 59% |
| F1-optimal threshold | -0.5 (drops only 10 of 180 chunks) |

Per-query precision at top-20:

| Query | Precision | Type |
|-------|-----------|------|
| ans_001 land value capture | 85% | Specific |
| ans_008 public transport NDC | 85% | Specific |
| ans_004 motorcycle safety | 75% | Moderate |
| ans_005 electric buses | 75% | Moderate |
| ans_003 NDC integration | 60% | Moderate |
| ans_007 slums/informality | 60% | Moderate |
| ans_009 housing affordability | 45% | Broad |
| ans_006 nature-based solutions | 30% | Broad |
| ans_002 denser cities | 20% | Very broad |

**Conclusion:** The reranker's ordering is useful (top-10 > positions 11-20) but its scores cannot provide absolute relevance thresholds. An LLM is required for reliable per-chunk discrimination on broad research queries.

## Phase 1: Tighten Retrieval Parameters

Config-only changes in `src/config/retrieval.ts` and a small edit to `src/app/api/answer/route.ts`.

### Changes

| Parameter | Before | After | Rationale |
|-----------|--------|-------|-----------|
| `rerankTopN` | 20 | 50 | Reranker processes 2.5x more fusion candidates, better pool |
| `maxResults` | 20 | 15 | Return fewer, tighter results from search service |
| `alpha` | 0.5 | 0.65 (pending sweep) | Favor semantic search for broad queries; keyword noise is the primary source of irrelevant results |
| Normalized threshold | 0.75 | **Removed** | Per-query normalization destroys absolute signal; replaced by LLM filter in Phase 2 |

### Alpha Sweep

Before committing alpha, sweep [0.5, 0.6, 0.65, 0.7] with rerankTopN=50 on the 9 golden queries. Measure precision@8 (the number that reaches synthesis). Pick the value that maximizes precision@8 without catastrophic recall loss.

### Cite Mode Unchanged

All changes are answer-mode only. Cite mode retains `alpha: 0.5`, `rerankTopN: 40`, `denseTopK: 500`, `sparseTopK: 500`.

## Phase 2: LLM Relevance Filter

A GPT-5.4-nano classifier runs between retrieval and synthesis, replacing the normalized threshold as the precision gate.

### Pipeline

```
Search service (rerank 50 → return top 15)
    → Answer route receives 15 chunks
    → Shuffle chunks (prevent position bias)
    → Send query + shuffled chunks to GPT-5.4-nano
    → Nano classifies each: strong / partial / weak
    → Nano rates overall coverage: good / limited / poor
    → Drop weak chunks
    → Send strong + partial (up to 8) to GPT-5.4 synthesis
    → Tier labels + coverage flow to frontend
```

### Nano Classifier Prompt

```
Given a research question and a set of passages, classify each passage's relevance to the question.

Question: {query}

Passages (presented in random order):
[1] "{title}" — {snippet}
[2] "{title}" — {snippet}
...

For each passage, classify as:
- "strong": Directly answers or provides specific evidence for the question
- "partial": Related to the topic but does not directly address the question
- "weak": Not meaningfully relevant to the question

Also rate overall corpus coverage for this question:
- "good": Multiple passages directly address the question
- "limited": Some relevant material but significant gaps exist
- "poor": No passages adequately address the question

Return JSON only:
{"relevance":[{"id":1,"tier":"strong"},{"id":2,"tier":"partial"},...],"coverage":"good"}
```

Design decisions:
- **Passages shuffled** before sending — prevents position bias (same debiasing methodology as `relabel-answer-chunks.ts`)
- **No reranker scores in prompt** — prevents score bias leaking into LLM judgment
- **Tier vocabulary matches synthesis prompt** — consistent strong/partial/weak throughout pipeline
- **Coverage is first-class output** — replaces the separate `/api/answer-coverage` nano pre-check

### Edge Cases

- **All chunks weak:** Return low-coverage response immediately, skip synthesis call. Saves a GPT-5.4 call.
- **Nano call fails:** Fall back to passing all 15 chunks to synthesis with no tier labels. Log error. Synthesis prompt still has "EVALUATE FIRST" as safety net.
- **Fewer than 3 strong+partial:** Proceed with synthesis but attach `low_coverage` warning.

### Latency Budget

| Step | Latency |
|------|---------|
| Search service (fusion + rerank 50) | ~1.0s |
| Nano filter (~750 input tokens) | ~50-100ms |
| Synthesis (GPT-5.4) | ~1.0s |
| **Total** | **~2.1s** (vs ~2.0s today) |

### What This Replaces

- The 0.75 normalized score threshold in the answer route (broken — per-query normalization)
- The `/api/answer-coverage` nano pre-check route (subsumed — this provides per-chunk + coverage)
- The "EVALUATE FIRST" instruction as the primary relevance gate (synthesis still has it as a safety net, but filter does the heavy lifting)
- The gated logit floor experiment in the search service answer branch (`answer_use_logit_floor`, `answer_logit_floor`, etc.)

## UI Changes

### Tier Labels on Passages

Answer mode passages receive color-coded tier labels matching cite mode:
- **Strong** (green): Passage directly addresses the query
- **Partial** (yellow): Related but not directly addressing
- Weak passages are filtered out and not shown

Labels come from the nano classifier output, mapped back to passages by doc_id.

### Coverage Warning

When nano returns `coverage: "limited"` or `coverage: "poor"`, display a warning banner above the synthesis:
- "Limited": "Only a few sources were directly relevant to this query."
- "Poor": "The available sources do not adequately cover this topic."

Same UI pattern as existing `low_coverage` warning.

## Cleanup

Remove experimental answer-mode scoring code that the LLM filter replaces:

- `search-service/app/config.py`: Remove `answer_logit_floor`, `answer_strong_threshold`, `answer_partial_threshold`, `answer_use_logit_floor`
- `search-service/app/main.py`: Remove gated logit floor block in answer branch (lines ~1199-1215)
- `src/app/api/answer-coverage/route.ts`: Remove entire route (subsumed by inline filter)
- Update `docs/superpowers/specs/2026-03-20-answer-mode-scoring-design.md` with pointer to this spec

## Evaluation Strategy

### Layer 1: Retrieval Precision Sweep (Phase 1 validation)

Sweep alpha × rerankTopN on the 9 golden queries using existing GPT-5.4 labels. Measure precision@K for K=8,10,12,15. Validates Phase 1 parameter changes in isolation before Phase 2 touches anything.

Script: Extend `evaluation/calibrate-answer-thresholds.ts` with alpha sweep capability (requires parameterizing the search service call).

### Layer 2: LLM Filter Accuracy (Phase 2 validation)

Run the nano classifier on top-15 chunks for all 9 queries. Compare nano's strong/partial/weak assignments against GPT-5.4 debiased labels from `answer-labels-review.json`. Measure:
- Agreement rate (nano tier vs label tier)
- Confusion matrix
- Per-query filter precision (what fraction of chunks nano passes are actually relevant)

### Layer 3: End-to-End Synthesis Comparison

Capture synthesis on all 9 queries under three conditions:
1. Baseline (current main branch)
2. Phase 1 only (tightened retrieval, no LLM filter)
3. Phase 1 + Phase 2 (full pipeline)

LLM-eval all three on: faithfulness, completeness, conciseness, coherence. Compare across conditions.

### Success Criteria

- Phase 1: Precision@8 improves from ~60% to ≥70%
- Phase 2: Precision at synthesis input ≥85% (nano filter drops the remaining irrelevant chunks)
- Coverage warnings fire on ans_002 and ans_006 (known low-coverage queries)
- Synthesis quality does not regress (faithfulness ≥ baseline)

## Documentation Updates

After implementation:
- Update `search-service/README.md` with new retrieval parameters
- Update `evaluation/README.md` with new eval scripts
- Update `.env.example` with any new env vars (nano model config)
- Update `docs/superpowers/specs/2026-03-20-answer-mode-scoring-design.md` with deprecation note
