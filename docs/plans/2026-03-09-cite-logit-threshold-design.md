# Cite Mode Raw Logit Threshold Calibration

## Problem

Cite mode has no absolute relevance floor. The reranker scores are min-max normalized per query, so the worst result always maps to 0.15 regardless of actual quality. A search for "banana farming" with one vaguely related document still shows it at score 1.0. The existing `CITE_SCORE_FLOOR = 0.15` in the Next.js layer filters on normalized scores and is effectively a no-op since the display floor remap already guarantees 0.15 as the minimum.

## Goal

Add a raw reranker logit threshold in the search service that drops genuinely irrelevant results before normalization. The threshold must preserve current recall (>=75% on the golden set) while cutting the irrelevant tail.

## Constraints

- Single global threshold (not per-query-type)
- Applied in the Python search service, not the Next.js layer
- Backwards compatible (opt-in parameter, no behavior change when unset)
- Cite mode only (answer mode is a separate future effort)
- Recall is the priority over precision

## Design

### 1. Search service change (main.py)

Add a new optional parameter to `QueryRequest`:

```python
cite_logit_floor: Optional[float] = None
```

After reranking (stage 2) but before metadata filtering (stage 2.5), add:

```python
if request.mode == "cite" and request.cite_logit_floor is not None:
    pre_floor_count = len(stage2_results)
    stage2_results = [r for r in stage2_results if r.score >= request.cite_logit_floor]
    logger.info(f"Stage 2.2 (Logit Floor): {pre_floor_count} -> {len(stage2_results)} results (floor={request.cite_logit_floor})")
```

Once calibrated, set the default value in config so it applies automatically.

### 2. Calibration script (evaluation/calibrate-cite-threshold.ts)

New script that:

1. Runs all 11 golden cite queries against the search service
2. For each result, records: query_id, doc_url, raw_score (from `doc.metadata.raw_score`), is_true_positive (matches golden URL)
3. Sweeps thresholds across the observed logit range (e.g., min to max in 0.1 increments, then finer around candidates)
4. At each threshold, computes:
   - Recall (true positives retained / total expected)
   - Precision (true positives / total retained)
   - F1
   - Total docs dropped
5. Outputs a table: threshold, recall, precision, F1, docs_dropped
6. Highlights the most aggressive threshold that maintains >=75% recall

Input: golden-dataset.json (11 test cases, 42 expected documents)

Output: JSON report saved to evaluation/results/ with the full sweep data and recommended threshold.

### 3. Next.js layer cleanup

After the search service threshold is set:

- Remove `CITE_SCORE_FLOOR = 0.15` filtering from `src/app/api/llamaindex/route.ts` (redundant)
- Keep `CITE_MIN_DOCS = 12` as a safety net (decision to remove deferred until we see whether the calibrated threshold causes any query to drop below 12 results)
- Keep `CITE_MAX_DOCS = 32` unchanged

### 4. Validation

Re-run `evaluation/run-cite-eval.ts` with the threshold applied to confirm:

- Recall >= 75% (current baseline)
- No regression on any individual golden query

## Open decisions

- **CITE_MIN_DOCS safety net**: Keep or remove after seeing logit distributions. If every query still returns 12+ results after thresholding, the safety net is unnecessary.
- **Default vs. configurable**: Once calibrated, the threshold could be hardcoded in config or remain a request parameter for flexibility. Recommend hardcoding with override.

## Sequence

1. Write calibration script
2. Run against live service, collect logit distributions
3. Analyze distributions, pick threshold
4. Add threshold parameter to search service
5. Set calibrated default
6. Clean up Next.js layer
7. Re-run cite eval to validate
