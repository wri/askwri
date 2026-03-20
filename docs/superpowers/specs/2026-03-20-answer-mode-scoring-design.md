# Answer Mode Scoring and Relevance Filtering

**Date:** 2026-03-20
**Status:** Approved
**Scope:** Answer mode retrieval filtering and synthesis input quality
**Related:** `docs/plans/2026-03-19-cite-logit-threshold-and-tiers-design.md` (cite mode equivalent)

## Problem

Answer mode has no absolute relevance floor. The search service returns up to 20 reranked chunks, which are then filtered in the Next.js answer route using a 0.75 threshold on min-max normalized scores. Because normalization is per-query, the worst result set still passes chunks through — a query with all bad results normalizes the best bad result to 1.0. Every query gets 6-8 chunks fed to GPT-5.2 for synthesis regardless of actual relevance.

This is the same problem cite mode had before PR #118 introduced logit-based thresholds. But the solution differs: cite mode optimizes for **recall** (users browse and pick), answer mode optimizes for **precision** (every irrelevant chunk dilutes the synthesis).

## Goals

- Drop irrelevant chunks before they reach the synthesis LLM, using calibrated raw logit thresholds
- Determine optimal retrieval parameters (rerankTopN, potentially others) for precision-oriented answer mode
- Surface a low-coverage signal when the corpus doesn't have good material for a query
- Use LLM labels from `answer-labels-review.json` as proxy ground truth (900 labeled chunks across 9 questions, ~20% relevant / ~8% partial / ~70% irrelevant)
- Produce reusable calibration tooling that can be re-run when human labels arrive

## Non-Goals

- Relevance tier UI in SupportingCitations (deferred — primary value is cleaner synthesis input)
- Human review of answer golden sets (acknowledged gap, working without for now)
- Changes to the synthesis prompt or model

## Prior Art: Cite Mode

PR #118 introduced logit-based filtering for cite mode:

| Config | Value | Basis |
|--------|-------|-------|
| `cite_logit_floor` | -9.0 | Calibrated against 11-query golden set with human-validated URLs |
| `cite_strong_threshold` | -2.3 | 70th percentile of relevant score distribution |
| `cite_partial_threshold` | -7.8 | 25th percentile of relevant score distribution |

Cite mode deduplicates by document (one chunk per doc). Answer mode does not — it returns individual chunks because synthesis benefits from multiple relevant passages per document.

## Approach: Calibrate First, Then Decide

Rather than porting cite thresholds directly, we calibrate against answer mode's own score distributions using LLM labels as proxy ground truth. The calibration data determines both thresholds and retrieval param changes. Implementation follows only after we have data.

## Design

### 1. Calibration Script

**`evaluation/calibrate-answer-thresholds.ts`**

Runs all 9 answer golden queries against the live search service. For each returned chunk, records the raw reranker logit score and matches against LLM labels from `answer-labels-review.json` by `chunk_id`.

**Label mapping:**
- `relevant` → true positive
- `partially_relevant` → true positive (conservative — count as relevant for threshold calibration)
- `not_relevant` or unlabeled → negative

**Sweep 1 — Logit floor (precision-oriented):**
1. Sweep floor thresholds from min to max observed logit in 0.25 increments, then 0.1 around candidates
2. At each threshold: compute precision, recall, F1, chunks retained/dropped
3. Recommend: most aggressive threshold maintaining precision >= 80% (inverted from cite mode's recall >= 75%)
4. Also report the F1-optimal point for comparison

**Sweep 2 — rerankTopN:**
- Try values: [10, 15, 20, 30, 40]
- For each, run the logit floor sweep
- Report the optimal (rerankTopN, floor) pairing that maximizes precision while keeping recall reasonable

**Sweep 3 — Page-1 demotion impact:**
- Report raw scores for chunk_index=0 chunks both with and without the 0.5x demotion multiplier
- Determine whether abstract demotion is helping or hurting answer mode precision
- **Known issue:** The existing demotion (`node.score * 0.5`) has inverted semantics for negative logit scores — multiplying a negative score by 0.5 makes it *less* negative (closer to zero), which *promotes* rather than demotes. For example, a chunk at raw logit -8.0 becomes -4.0 after "demotion." The calibration will quantify this and likely recommend either reordering (floor before demotion) or replacing the 0.5x multiplier with an additive penalty.

**Statistical note:** With 9 queries and ~28 positives per query, per-query precision estimates have wide confidence intervals. The calibration script should report aggregate metrics and note that thresholds are provisional until more queries are labeled or human review is complete.

**Tier boundaries:**
- `strong_threshold`: 70th percentile of relevant score distribution (same methodology as cite)
- `partial_threshold`: 25th percentile of relevant score distribution

**Output:** JSON report to `evaluation/results/answer-threshold-calibration-{timestamp}.json` containing:
- Full sweep tables (threshold × recall × precision × F1 × chunks)
- Combined rerankTopN × floor sweep matrix
- Score distributions (relevant vs irrelevant, pre- and post-demotion)
- Recommended thresholds and retrieval params
- Raw per-chunk data for further analysis

**Prerequisites:** Search service running on :8000

**Usage:**
```bash
npx tsx --env-file-if-exists=.env evaluation/calibrate-answer-thresholds.ts
```

### 2. Search Service Changes

**`search-service/app/config.py`** — New config values:

```python
# Answer mode reranker logit thresholds (values set after calibration)
answer_logit_floor: float = -999.0        # disabled until calibrated
answer_strong_threshold: float = -999.0
answer_partial_threshold: float = -999.0
answer_use_logit_floor: bool = False       # gate — flip after calibration validates
```

Defaults are effectively no-ops. The `answer_use_logit_floor` gate allows deploying the code without activating it.

**`search-service/app/main.py`** — Replace the answer mode branch (currently lines 1198-1200):

```
else (answer mode):
    if settings.answer_use_logit_floor:
        # Stage 3: Logit floor — drop chunks below calibrated threshold
        pre_floor = len(stage2_results)
        stage2_results = [n for n in stage2_results
                          if n.score >= settings.answer_logit_floor]
        log: "Stage 3 (Answer Logit Floor): {pre_floor} → {len} chunks"

        # Stage 3.1: Tier assignment
        for node in stage2_results:
            raw = node.score
            if raw >= settings.answer_strong_threshold:
                tier = "strong"
            elif raw >= settings.answer_partial_threshold:
                tier = "partial"
            else:
                tier = "weak"
            node.node.metadata["relevance_tier"] = tier

    filtered_results = stage2_results[:request.max_results]
```

Key differences from cite mode:
- Operates on individual chunks (no doc-level dedup)
- Gated behind `answer_use_logit_floor` flag
- Page-1 demotion runs before this block (existing order preserved; calibration data will tell us if this needs changing)

**`src/config/retrieval.ts`** — Update `ANSWER_PRESET` based on calibration results. Current values:

```typescript
export const ANSWER_PRESET: RetrievalParams = {
  rerankTopN: 20,    // may change based on calibration
  maxResults: 20,    // may change based on calibration
  denseTopK: 150,
  sparseTopK: 150,
  alpha: 0.5,
};
```

Specific changes deferred until calibration data is available.

### 3. Answer Route Changes

**Phase 1 (with calibration, gate off):** No changes to `src/app/api/answer/route.ts`. The existing 0.75 normalized score filter and maxDocs=8 cap remain active. Search service returns the same results it does today.

**Phase 2 (after calibration validates the approach, gate on):** Replace normalized score filtering with trust in service-side logit floor:

- Remove `RELEVANCE_THRESHOLD = 0.75` and the `.filter()` on normalized scores (lines 213-223)
- Keep `maxDocs` cap (8 for GPT-5, 6 for older)
- Add low-coverage detection:

```typescript
const MIN_DOCS_FOR_CONFIDENCE = 3

// After receiving docs from search service
if (filteredDocs.length === 0) {
  // No relevant chunks survived the floor — skip synthesis entirely
  return NextResponse.json({
    ok: true,
    synthesis: {
      sentences: ['No sufficiently relevant sources were found to answer this query.'],
      warning: 'no_coverage',
      warningMessage: 'The corpus does not appear to contain material relevant to this question.',
    },
    debug: debugInfo,
  })
}

if (filteredDocs.length < MIN_DOCS_FOR_CONFIDENCE) {
  // Attach warning to synthesis response (synthesis still runs)
  synthesis.warning = 'low_coverage'
  synthesis.warningMessage =
    'Limited relevant sources found for this query. The answer may not fully address your question.'
}
```

**Frontend warning rendering:** The answer mode component (`AIResearchModal.tsx`) currently stores `synthesis.warning` in state but only logs it to console — it does not render warnings visually. Phase 2 requires adding a small UI element (e.g., an `InlineMessage` or `Alert`) to display the low-coverage warning to users.

### 4. Eval Validation

**Before/after retrieval comparison:**
- Run `npm run eval:answer-retrieval` with current params (baseline)
- Run again after threshold/param changes
- Compare precision@k, recall@k per query

**Before/after synthesis comparison:**
- Run synthesis eval pipeline with **GPT-5.4** as evaluator (upgrade from 5.2):
  - Stage 1: `npx tsx evaluation/run-answer-synthesis-capture.ts` (capture system outputs)
  - Stage 2: `SYNTHESIS_EVAL_MODEL=gpt-5.4 npx tsx evaluation/run-answer-synthesis-llm-eval.ts` (LLM evaluation)
- Compare 5-dimension scores: faithfulness, completeness, conciseness, coherence, citation accuracy
- Expected: higher faithfulness and conciseness from tighter input; watch for completeness regression

**Calibration script itself** produces the primary validation data — sweep tables showing precision/recall at each threshold, so we can make an informed decision before flipping the gate.

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `evaluation/calibrate-answer-thresholds.ts` | New | Calibration sweep script |
| `search-service/app/config.py` | Modify | Add answer threshold config + gate |
| `search-service/app/main.py` | Modify | Answer logit floor + tier assignment (gated) |
| `src/config/retrieval.ts` | Modify | Update ANSWER_PRESET after calibration (deferred) |
| `src/app/api/answer/route.ts` | Modify | Replace normalized filter, add low-coverage warning (Phase 2, deferred) |
| `src/app/components/AnswerMode/AIResearchModal.tsx` | Modify | Render low-coverage warning visually (Phase 2, deferred) |

## Sequence

1. Write calibration script
2. Run calibration against live service — collect score distributions, sweep results
3. Analyze: pick floor + tier thresholds, optimal rerankTopN, page-1 demotion verdict
4. Add gated logit floor + tier assignment to search service with calibrated values
5. Run answer retrieval eval — compare before/after
6. Run synthesis eval with GPT-5.4 — compare before/after
7. If validated: flip gate, update ANSWER_PRESET, replace answer route filtering (Phase 2)
8. If not validated: adjust thresholds or retrieval params based on data, re-run from step 5

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| LLM labels are noisy (no human validation) | Conservative precision target (80%), feature gate for easy rollback, reusable calibration script for when human labels arrive |
| Answer mode score distributions differ significantly from cite mode | Calibration script discovers this before any code changes |
| Page-1 demotion has inverted semantics for negative logits (0.5x multiplier promotes instead of demotes) | Calibration reports pre/post-demotion scores; likely fix is reorder (floor before demotion) or additive penalty |
| Low coverage warning fires too often | MIN_DOCS_FOR_CONFIDENCE is tunable; calibration data shows per-query chunk counts |
