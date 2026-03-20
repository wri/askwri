# Cite Mode Logit Floor and Relevance Tiers

**Date:** 2026-03-19
**Status:** Draft
**Scope:** Cite mode only (answer mode deferred until human review of answer labels)
**Related:** `2026-03-16-relevance-tiers-and-ui-design.md` (full plan, both modes)

## Problem

Cite mode has no absolute relevance floor. Reranker scores are min-max normalized per query, so the worst result always maps to 0.15 regardless of actual quality. The existing `CITE_SCORE_FLOOR = 0.15` in the Next.js layer filters on normalized scores and is effectively a no-op. Every result gets a green badge.

## Goals

- Drop genuinely irrelevant cite results using a raw logit floor before normalization
- Communicate relevance as qualitative tiers: Strong Match / Partial Match / Weak Match
- Preserve recall >= 75% on the golden set (recall is the priority for cite mode)
- Expose raw scores to evaluators via tooltip
- Clean up redundant filtering logic in the Next.js layer

## Prior Analysis

A colleague's analysis of our corpus with `cross-encoder/ms-marco-MiniLM-L-6-v2` shows:

- Relevant docs cluster in the positive range (~0 to +8)
- Irrelevant docs cluster deeply negative (~-8 to -12)
- Overlap zone: roughly -5 to 0

Operating points from their sweep:

| Point | Floor | Recall | Precision |
|-------|-------|--------|-----------|
| Cite floor (recall >= 75%) | -4.79 | 76% | 48% |
| F1-optimal | -5.37 | 89% | 48% |

The F1-optimal point at -5.37 is attractive: 89% recall with no precision penalty vs the tighter -4.79 floor. Our calibration script will verify against the current index and golden set.

## Design

### 1. Calibration Script

**`evaluation/calibrate-cite-thresholds.ts`**

Runs all 11 cite golden queries against the live search service. For each returned doc, records `raw_score` (from `metadata.raw_score`) and whether it matches a golden URL.

**Sweep:**
1. Sweep floor thresholds from min to max observed logit in 0.25 increments, then 0.1 around candidates
2. At each threshold: compute recall, precision, F1, docs dropped
3. Output JSON report to `evaluation/results/cite-threshold-calibration-{timestamp}.json`

**Report contains:**
- Full sweep table (threshold, recall, precision, F1, docs_dropped)
- Recommended thresholds:
  - `floor`: most aggressive threshold maintaining recall >= 75%
  - `strong_threshold`: cutpoint for top ~30% of relevant distribution
  - `partial_threshold`: cutpoint at bottom of relevant distribution
- Score distribution data (relevant vs not-relevant)

Prints summary table to stdout.

### 2. Search Service Changes

**`search-service/app/config.py`** — New config values:

```python
CITE_LOGIT_FLOOR: float = -5.37       # set after calibration
CITE_STRONG_THRESHOLD: float = 3.0    # set after calibration
CITE_PARTIAL_THRESHOLD: float = 0.0   # set after calibration
```

**`search-service/app/main.py`** — Pipeline changes after reranking:

Current pipeline:
```
Stage 2: Rerank → Stage 2.1: Page-1 Demotion → Normalize → [Cite: remap to 0.15-1.0] → Return
```

New pipeline:
```
Stage 2: Rerank
Stage 2.1: Logit Floor — drop cite results below CITE_LOGIT_FLOOR
Stage 2.2: Tier Assignment — assign relevance_tier from raw score
Stage 2.3: Page-1 Demotion (answer mode only, unchanged, renumbered)
Stage 2.4: Normalize — min-max normalize survivors
         — Remove cite-mode [0.15, 1.0] remap (floor makes it unnecessary)
```

Floor and tier assignment run on raw reranker scores, before page-1 demotion and normalization.

**`DocumentResult` schema** — Add field:

```python
relevance_tier: str = ""  # "strong" | "partial" | "weak"
```

Existing `score` field continues returning normalized values. `raw_score` stays in `metadata`.

**Scope:** Answer mode is untouched. No `ANSWER_LOGIT_FLOOR`, no answer tier thresholds.

### 3. Frontend Changes

**`src/app/api/llamaindex/route.ts`:**
- Remove `CITE_SCORE_FLOOR = 0.15` and its filtering logic
- Keep `CITE_MAX_DOCS = 32` (display cap)
- Keep `CITE_MIN_DOCS = 12` (safety net until verified unnecessary)
- Pass through `relevance_tier` and `raw_score` from service response

**`src/lib/llamacloud.ts`** — Add to `KP` type:
```typescript
relevance_tier?: string  // "strong" | "partial" | "weak"
raw_score?: number
```

**`src/app/utils/relevance.ts`** — Rewrite:
- `getRelevanceLevel(tier: string)` → "strong" -> "Strong Match", "partial" -> "Partial Match", "weak" -> "Weak Match"
- `getRelevanceColor(tier: string)` → green (#22c55e) / amber (#f59e0b) / gray (#94a3b8)

**`src/app/components/results/SelectableResultRow.tsx`:**
- Badge uses `relevance_tier` for label and color (replaces hardcoded green)
- Tooltip on hover shows `raw_score`

**`src/app/results/CitePanel.tsx`:**
- Pass `relevance_tier` and `raw_score` through to `RowData`

**Not touched:** `src/app/api/answer/route.ts`, `SupportingCitations.tsx` — answer mode deferred.

### 4. Validation

1. Run `npm run eval:cite` — confirm recall >= 75%, no regression on individual queries
2. Spot-check 3-5 queries in UI — verify tier badges and raw score tooltips
3. Check whether `CITE_MIN_DOCS` safety net fires after floor (remove in follow-up if not)

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `evaluation/calibrate-cite-thresholds.ts` | New | Calibration sweep script |
| `search-service/app/config.py` | Modify | Add cite threshold config |
| `search-service/app/main.py` | Modify | Logit floor, tier assignment, remove cite remap |
| `src/app/api/llamaindex/route.ts` | Modify | Remove score filtering, pass through tier + raw_score |
| `src/lib/llamacloud.ts` | Modify | Add relevance_tier and raw_score to KP type |
| `src/app/utils/relevance.ts` | Modify | Map tier strings to labels/colors |
| `src/app/components/results/SelectableResultRow.tsx` | Modify | Tier badge + raw score tooltip |
| `src/app/results/CitePanel.tsx` | Modify | Pass tier and raw_score to RowData |

## Sequence

1. Write calibration script
2. Run calibration against live service, collect score distributions
3. Analyze distributions, pick floor + tier thresholds
4. Add floor filtering + tier assignment to search service
5. Set calibrated defaults in config
6. Remove cite-mode [0.15, 1.0] remap
7. Update frontend: tier badges, tooltips, cleanup route.ts
8. Run cite eval to validate
9. Spot-check tier assignments in UI
