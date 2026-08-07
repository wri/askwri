# Relevance Tiers, Logit Floor, and UI Redesign

**Date:** 2026-03-16
**Status:** Draft
**Supersedes:** `2026-03-09-cite-logit-threshold-design.md` (expanded scope: both modes, tier assignment, frontend)

## Problem

Three related issues with how the app communicates relevance:

1. **No absolute relevance floor.** Reranker scores are min-max normalized per query, so the worst result always maps to 0.15 (cite) or 0.0 (answer) regardless of actual quality. A search with one vaguely related document shows it at score 1.0.

2. **Misleading score display.** The frontend shows normalized floats directly to users. Every cite result gets a green badge. Answer mode color-codes against normalized scores, so the tiers shift meaning between queries.

3. **Inconsistent treatment across modes.** Cite mode applies a `CITE_SCORE_FLOOR = 0.15` filter in the Next.js layer (effectively a no-op). Answer mode has no filtering at all. Neither mode communicates relevance qualitatively.

## Goals

- Drop genuinely irrelevant results before they reach the user (both modes)
- Communicate relevance as qualitative tiers — Strong Match / Partial Match / Weak Match
- Calibrate cite mode for recall, answer mode for precision
- Provide raw score access for evaluators via tooltip
- Clean up redundant filtering logic in the Next.js layer

## Background: How Reranker Scores Work

### The retrieval pipeline

The search pipeline has two retrieval stages:

1. **Stage 1 — Retrieval** (dense + sparse fusion): Casts a wide net using vector similarity (OpenAI embeddings) and BM25 keyword matching, fused with Reciprocal Rank Fusion. Returns hundreds of candidate chunks. The scores at this stage are positional (rank-based), not semantic confidence.

2. **Stage 2 — Reranking**: Feeds each candidate through a **cross-encoder** — a neural model that reads the query and candidate passage *together* as a single input and outputs a relevance score. This is fundamentally different from Stage 1, where query and document embeddings are compared independently. The cross-encoder sees both texts at once, enabling it to assess semantic relationships that embedding similarity misses.

### Score vs. position

These are distinct concepts in the pipeline:

- **Position** (rank): Where a result appears in the sorted list. Determined by sorting on score. Position is relative — it only tells you "this result is better than the one below it."
- **Score**: A numeric value assigned by the scoring model. In Stage 1, scores are rank-fusion values (not meaningful in isolation). In Stage 2, scores are cross-encoder outputs that carry absolute meaning — a score of +5.0 indicates strong relevance regardless of what other results exist.

The current UI conflates these by min-max normalizing scores, which effectively reduces scores back to positions. This design restores the distinction.

### The reranker model

Both modes use `cross-encoder/ms-marco-MiniLM-L-6-v2` (22M parameters, fast on CPU/Fargate), loaded via LlamaIndex's `SentenceTransformerRerank`. The model was fine-tuned on MS MARCO, a large-scale passage ranking dataset. The modes differ in `top_n` (answer: 20, cite: 200).

### How scores are computed

The cross-encoder works as follows:

1. Query and passage are concatenated with a `[SEP]` token and fed through a 6-layer transformer (MiniLM architecture)
2. The `[CLS]` token's final hidden state passes through a single linear layer to produce one number
3. No activation function is applied (`Identity()`) — the output is the **raw logit** from the linear layer

This means scores are **unbounded real numbers on a linear scale** (not log scale, not probabilities). They can be negative. The score represents learned relevance — higher means the model is more confident the passage answers the query, but the magnitude is not calibrated to any particular probability.

### Observed score ranges

Tested against our corpus with MiniLM-L-6-v2:

| Example | Score |
|---------|-------|
| Query about land value capture → passage about land value capture mechanisms | **+4.9** |
| Query about land value capture → passage about climate change | **-11.0** |
| Query about land value capture → passage about budget approvals | **-11.1** |
| Query about banana farming → passage about zoning laws | **-11.3** |

Relevant passages score in the **positive range** (~+1 to +10). Irrelevant passages cluster deeply negative (~-8 to -11). The gap between relevant and irrelevant is large, which is what makes threshold-based filtering viable.

The calibration script will map the full distribution across our golden set queries to find precise cutpoints.

### What the app currently does with scores

After reranking, the service applies **min-max normalization** per query (`main.py:1162-1175`):

```
normalized = (raw_score - min_score) / (max_score - min_score)
```

The highest-scoring result maps to 1.0, the lowest to 0.0 (or 0.15 in cite mode via a secondary remap). This destroys the absolute signal:

- A query where the best result scores +8.5 (strong) and the worst scores +3.2 (moderate) → top shows 1.0, bottom shows 0.0
- A query where the best scores +1.1 (weak) and the worst scores -4.0 (irrelevant) → top also shows 1.0, bottom also shows 0.0

Both look identical to the user. The normalized score only encodes position within the result set, not the reranker's actual confidence.

### What this design changes

Instead of relying on normalized scores, we apply thresholds directly to the raw logits:
- **Floor threshold**: a minimum raw score below which results are dropped entirely (e.g., anything below 0.0 is irrelevant)
- **Tier thresholds**: raw score cutpoints that bucket surviving results into Strong Match / Partial Match / Weak Match

Because these thresholds operate on the raw reranker output (before normalization), they have consistent meaning across queries. A "Strong Match" always means the reranker was confident, regardless of what else was in the result set. The normalized score is kept in the response for backward compatibility but is no longer used for display.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Relevance labels | Strong Match / Partial Match / Weak Match | Descriptive, tells user about document-query relationship |
| Tier boundaries | Raw score thresholds (not per-query normalization) | Consistent meaning — "Strong Match" always means high reranker confidence |
| Tier computation location | Search service (Python) | Coupled to reranker model; stays in sync when models change |
| Debug view | Tooltip on hover showing raw score | Zero UI clutter for researchers, one hover for evaluators |
| Floor scope | Both cite and answer modes | Both suffer from the same normalization problem |
| Cite optimization | Recall ≥75% | Researchers need breadth to triage |
| Answer optimization | Precision | Synthesis LLM produces better answers without weak passages |

## Architecture

### Search Service Pipeline (after reranking)

Current pipeline:
```
Stage 2: Rerank → Min-max normalize → [Cite: remap to 0.15–1.0] → Return
```

New pipeline:
```
Stage 2: Rerank
Stage 2.1: Logit Floor — drop results below mode-specific raw score threshold
Stage 2.2: Tier Assignment — assign relevance_tier from raw score
Stage 2.3: Page-1 Demotion (answer mode only) — halve score for chunk_index==0
            Moved from its current position to AFTER floor + tier so that
            floor/tier thresholds are calibrated against raw reranker output
Stage 2.4: Normalize — min-max normalize surviving results (backward compat)
            Remove cite-mode [0.15, 1.0] remap (floor handles this now)
```

**Ordering note:** Floor and tier assignment must run on raw reranker scores, before the existing page-1 demotion (which halves scores for abstract chunks in answer mode). The demotion moves from its current "Stage 2.1" position to Stage 2.3.

### Config Values

Per-mode thresholds, calibrated per reranker model:

```python
# Floor thresholds — minimum raw score to survive
CITE_LOGIT_FLOOR: float       # calibrated for recall ≥75%
ANSWER_LOGIT_FLOOR: float     # calibrated for precision

# Tier boundaries — raw score cutpoints
CITE_STRONG_THRESHOLD: float
CITE_PARTIAL_THRESHOLD: float
ANSWER_STRONG_THRESHOLD: float
ANSWER_PARTIAL_THRESHOLD: float
```

### Response Schema Change

Add one field to `DocResult`:

```python
class DocResult:
    # existing fields unchanged...
    relevance_tier: str = ""  # "strong" | "partial" | "weak"; always populated after stage 2.2
```

The existing `score` field continues to return the normalized value for backward compatibility. `raw_score` remains in `metadata` for debug access.

## Calibration

### Script: `evaluation/calibrate-relevance-thresholds.ts`

Replaces the planned `calibrate-cite-threshold.ts` with a unified script covering both modes.

**Pass 1 — Cite mode** (against `golden-dataset.json`, 11 queries):
1. Hit search service for each query, collect raw scores + ground truth matches
2. Sweep floor thresholds — compute recall, precision, F1 at each candidate
3. Select most aggressive floor maintaining recall ≥75%
4. Sweep tier boundaries — optimize for intuitive distribution

**Pass 2 — Answer mode** (against `answer-golden-dataset.json`, 9 queries):
1. Same collection process, same reranker model (both modes use MiniLM-L-6-v2) but different score distributions due to page-1 demotion and different top_n settings (20 vs 200)
2. Sweep floor thresholds — maximize precision subject to recall ≥50%
3. Sweep tier boundaries — tighter distribution, fewer "Weak" results

**Output:** `evaluation/results/relevance-threshold-calibration.json`

```json
{
  "cite": {
    "floor": 0.35,
    "strong_threshold": 0.72,
    "partial_threshold": 0.48,
    "recall": 0.82,
    "precision": 0.31,
    "sweep_data": []
  },
  "answer": {
    "floor": 0.55,
    "strong_threshold": 0.78,
    "partial_threshold": 0.62,
    "recall": 0.64,
    "precision": 0.71,
    "sweep_data": []
  }
}
```

(Numbers illustrative — actual values from sweep.)

## Frontend Changes

### `src/app/utils/relevance.ts`

`getRelevanceLevel()` — returns display label from tier string:
- `"strong"` → `"Strong Match"`
- `"partial"` → `"Partial Match"`
- `"weak"` → `"Weak Match"`

`getRelevanceColor()` — maps tier to color:
- `"strong"` → green (`#22c55e`)
- `"partial"` → amber (`#f59e0b`)
- `"weak"` → slate gray (`#94a3b8`)

Both functions change from numeric-input to string-input. No more threshold logic in the frontend.

### `src/app/components/results/SelectableResultRow.tsx`

- Badge displays tier label with tier color (currently shows green for everything)
- Reads `rowData.relevance_tier` (string) for label/color
- Chakra `Tooltip` on hover shows raw score from `rowData.raw_score`

### `src/app/results/CitePanel.tsx`

- Update call to `getRelevanceLevel()`: pass `relevance_tier` (string from API) instead of `docRel` (number)
- Pass `relevance_tier` and `raw_score` through to `RowData`

### `src/app/components/AnswerMode/SupportingCitations.tsx`

- Same badge component as cite mode
- Reads `kp.relevance_tier` (string) instead of `kp.kp_relevance` (number) for label/color
- Replaces current numeric score + `getRelevanceColor` numeric thresholds

### `src/lib/llamacloud.ts`

Add `relevance_tier` to the `KP` type:

```typescript
export type KP = {
  kp_relevance: number    // kept for backward compat
  relevance_tier: string  // "strong" | "partial" | "weak"
  snippet: string
  // ...existing fields
}
```

### `src/app/api/llamaindex/route.ts`

**Remove:**
- `CITE_SCORE_FLOOR = 0.15` constant and filtering logic
- Score clamping/validation logic

**Keep:**
- `CITE_MAX_DOCS = 32` (display cap, UI concern)
- `CITE_MIN_DOCS = 12` (remove after validation — if calibrated floor never drops a query below 12 results, this is unnecessary)

**Pass through:**
- `relevance_tier` from service response into the mapped doc object and into each `kps` entry: `relevance_tier: doc.relevance_tier`
- `raw_score` from `metadata.raw_score` for tooltip access

### `src/app/api/answer/route.ts`

**Remove:**
- `RELEVANCE_THRESHOLD = 0.75` numeric filter on `kp_relevance` — redundant now that the search service applies `ANSWER_LOGIT_FLOOR` on raw scores. The service-level floor is the single source of truth for answer-mode filtering.

**Keep:**
- `maxDocs` limit (6 or 8) — display/context-window cap, still useful

## Search Service Detail

### `search-service/app/main.py`

After reranking (stage 2), before metadata filtering (stage 2.5):

```python
# Stage 2.1: Logit Floor
floor = CITE_LOGIT_FLOOR if request.mode == "cite" else ANSWER_LOGIT_FLOOR
pre_floor_count = len(stage2_results)
stage2_results = [r for r in stage2_results if r.score >= floor]
logger.info(f"Stage 2.1 (Logit Floor): {pre_floor_count} -> {len(stage2_results)} (floor={floor}, mode={request.mode})")

# Stage 2.2: Tier Assignment
strong_t = CITE_STRONG_THRESHOLD if request.mode == "cite" else ANSWER_STRONG_THRESHOLD
partial_t = CITE_PARTIAL_THRESHOLD if request.mode == "cite" else ANSWER_PARTIAL_THRESHOLD
for r in stage2_results:
    raw = float(r.score)
    if raw >= strong_t:
        r.relevance_tier = "strong"
    elif raw >= partial_t:
        r.relevance_tier = "partial"
    else:
        r.relevance_tier = "weak"
```

Remove the cite-mode `[0.15, 1.0]` remap (`normalized_score = 0.15 + (normalized_score * 0.85)`). The floor now prevents zero-score results, making this bandaid unnecessary.

### `search-service/app/config.py`

Add threshold config values with placeholder defaults (replaced after calibration):

```python
CITE_LOGIT_FLOOR: float = 0.0          # no-op until calibrated
ANSWER_LOGIT_FLOOR: float = 0.0        # no-op until calibrated
CITE_STRONG_THRESHOLD: float = 0.7     # placeholder
CITE_PARTIAL_THRESHOLD: float = 0.4    # placeholder
ANSWER_STRONG_THRESHOLD: float = 0.7   # placeholder
ANSWER_PARTIAL_THRESHOLD: float = 0.4  # placeholder
```

## Validation

After calibrating and applying thresholds:

1. Run `evaluation/run-cite-eval.ts` — confirm recall ≥75%, no regression on individual queries
2. Run `evaluation/run-answer-retrieval-eval.ts` — confirm precision improvement, acceptable recall
3. Manual spot-check: run 5-10 queries in both modes, verify tier assignments feel intuitive
4. Verify `CITE_MIN_DOCS` decision: if any cite query drops below 12 results after floor, keep the safety net (move to service); otherwise remove

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `search-service/app/main.py` | Modify | Add floor filtering, tier assignment, reorder page-1 demotion, remove cite remap |
| `search-service/app/config.py` | Modify | Add threshold config values |
| `evaluation/calibrate-relevance-thresholds.ts` | New | Unified calibration script |
| `src/lib/llamacloud.ts` | Modify | Add `relevance_tier` to `KP` type |
| `src/app/utils/relevance.ts` | Modify | Map tier strings to labels/colors |
| `src/app/results/CitePanel.tsx` | Modify | Pass tier string to relevance functions |
| `src/app/components/results/SelectableResultRow.tsx` | Modify | Tier badge + raw score tooltip |
| `src/app/components/AnswerMode/SupportingCitations.tsx` | Modify | Tier badge + raw score tooltip |
| `src/app/api/llamaindex/route.ts` | Modify | Remove score filtering, pass through tier |
| `src/app/api/answer/route.ts` | Modify | Remove `RELEVANCE_THRESHOLD = 0.75` filter |

## Sequence

1. Write calibration script
2. Run calibration against live service, collect score distributions
3. Analyze distributions, pick floor + tier thresholds for both modes
4. Add floor filtering + tier assignment to search service
5. Set calibrated defaults in config
6. Remove cite-mode `[0.15, 1.0]` remap
7. Update frontend: tier badges, tooltips, cleanup route.ts
8. Run cite + answer evals to validate
9. Manual spot-check tier assignments
