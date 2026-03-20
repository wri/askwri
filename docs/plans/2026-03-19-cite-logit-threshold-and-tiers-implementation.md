# Cite Logit Floor & Relevance Tiers Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add raw logit floor filtering and relevance tier assignment to cite mode, expose tiers and raw scores to the frontend.

**Architecture:** The Python search service applies a logit floor and assigns tier labels ("strong"/"partial"/"weak") based on raw reranker scores after Stage 2 reranking. The frontend receives tier strings and maps them to labels/colors. A calibration script sweeps thresholds against the cite golden set to find optimal values.

**Tech Stack:** Python (FastAPI/Pydantic), TypeScript (Next.js), Chakra UI, WRI Design System

---

### Task 1: Calibration Script

**Files:**
- Create: `evaluation/calibrate-cite-thresholds.ts`

This script queries the live search service with all 11 golden cite queries, collects raw scores, and sweeps floor/tier thresholds to find optimal values.

- [ ] **Step 1: Create the calibration script**

```typescript
/**
 * Cite mode logit threshold calibration.
 *
 * Sweeps floor thresholds against the cite golden set to find
 * the best tradeoff between recall (priority) and precision.
 * Also recommends tier boundaries (strong/partial/weak).
 *
 * Prerequisites: search service running on :8000
 * Usage: npx tsx --env-file-if-exists=.env evaluation/calibrate-cite-thresholds.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { checkPythonService, PYTHON_SERVICE_URL } from './lib/service-client';

// --- Types ---

interface GoldenTestCase {
  id: string;
  question: string;
  expected_urls: string[];
}

interface ScoredDoc {
  query_id: string;
  doc_url: string;
  raw_score: number;
  is_expected: boolean;
}

interface SweepPoint {
  threshold: number;
  recall: number;
  precision: number;
  f1: number;
  docs_retained: number;
  docs_dropped: number;
  true_positives: number;
  false_negatives: number;
}

interface CalibrationReport {
  timestamp: string;
  mode: 'cite';
  golden_queries: number;
  golden_expected_docs: number;
  total_retrieved_docs: number;
  recommended: {
    floor: number;
    floor_recall: number;
    floor_precision: number;
    strong_threshold: number;
    partial_threshold: number;
  };
  f1_optimal: {
    floor: number;
    recall: number;
    precision: number;
    f1: number;
  };
  sweep_data: SweepPoint[];
  score_distribution: {
    relevant: { min: number; max: number; median: number; p25: number; p75: number };
    not_relevant: { min: number; max: number; median: number; p25: number; p75: number };
  };
}

// --- Helpers ---

function extractUrlSlug(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

function urlMatch(retrievedUrl: string, expectedUrl: string): boolean {
  return extractUrlSlug(retrievedUrl) === extractUrlSlug(expectedUrl);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// --- Main ---

async function main() {
  // Check service
  const healthy = await checkPythonService();
  if (!healthy) {
    console.error('ERROR: Search service not available at', PYTHON_SERVICE_URL);
    process.exit(1);
  }

  // Load golden dataset
  const goldenPath = path.join(__dirname, 'golden-dataset.json');
  const goldenData = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));
  const testCases: GoldenTestCase[] = goldenData.test_cases;

  console.log(`\nCite Threshold Calibration`);
  console.log(`=========================`);
  console.log(`Golden set: ${testCases.length} queries\n`);

  // Collect all scored docs
  const allDocs: ScoredDoc[] = [];

  for (const tc of testCases) {
    process.stdout.write(`  ${tc.id}... `);

    const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: tc.question,
        mode: 'cite',
        max_results: 200,
        rerank: true,
        rerank_top_n: 200,
        include_metadata: true,
      }),
    });

    if (!response.ok) {
      console.error(`FAILED (${response.status})`);
      continue;
    }

    const data = await response.json();
    const docs = data.docs || [];

    // Dedupe by doc URL (keep best score per doc)
    const byUrl = new Map<string, number>();
    for (const doc of docs) {
      const url = doc.metadata?.url;
      if (!url) continue;
      const rawScore = doc.metadata?.raw_score ?? doc.score;
      const slug = extractUrlSlug(url);
      const existing = byUrl.get(slug);
      if (existing === undefined || rawScore > existing) {
        byUrl.set(slug, rawScore);
      }
    }

    let matched = 0;
    for (const [slug, rawScore] of byUrl) {
      const isExpected = tc.expected_urls.some(eu => extractUrlSlug(eu) === slug);
      if (isExpected) matched++;
      allDocs.push({
        query_id: tc.id,
        doc_url: slug,
        raw_score: rawScore,
        is_expected: isExpected,
      });
    }

    console.log(`${byUrl.size} docs, ${matched}/${tc.expected_urls.length} expected found`);
  }

  // Score distributions
  const relevantScores = allDocs.filter(d => d.is_expected).map(d => d.raw_score).sort((a, b) => a - b);
  const notRelevantScores = allDocs.filter(d => !d.is_expected).map(d => d.raw_score).sort((a, b) => a - b);

  console.log(`\nScore distributions:`);
  console.log(`  Relevant (${relevantScores.length}): min=${relevantScores[0]?.toFixed(2)}, median=${percentile(relevantScores, 50).toFixed(2)}, max=${relevantScores[relevantScores.length - 1]?.toFixed(2)}`);
  console.log(`  Not relevant (${notRelevantScores.length}): min=${notRelevantScores[0]?.toFixed(2)}, median=${percentile(notRelevantScores, 50).toFixed(2)}, max=${notRelevantScores[notRelevantScores.length - 1]?.toFixed(2)}`);

  // Total expected docs (unique per query)
  const totalExpected = testCases.reduce((sum, tc) => sum + tc.expected_urls.length, 0);

  // Sweep thresholds
  const allScores = allDocs.map(d => d.raw_score).sort((a, b) => a - b);
  const minScore = allScores[0];
  const maxScore = allScores[allScores.length - 1];

  // Coarse sweep: 0.25 increments
  const coarseCandidates: number[] = [];
  for (let t = Math.floor(minScore); t <= Math.ceil(maxScore); t += 0.25) {
    coarseCandidates.push(t);
  }

  function evaluateThreshold(threshold: number): SweepPoint {
    let tp = 0, fn = 0, retained = 0, dropped = 0;

    // Group by query for per-query recall
    const byQuery = new Map<string, ScoredDoc[]>();
    for (const doc of allDocs) {
      if (!byQuery.has(doc.query_id)) byQuery.set(doc.query_id, []);
      byQuery.get(doc.query_id)!.push(doc);
    }

    for (const tc of testCases) {
      const queryDocs = byQuery.get(tc.id) || [];
      for (const doc of queryDocs) {
        if (doc.raw_score >= threshold) {
          retained++;
          if (doc.is_expected) tp++;
        } else {
          dropped++;
          if (doc.is_expected) fn++;
        }
      }
    }

    const recall = totalExpected > 0 ? tp / totalExpected : 0;
    const precision = retained > 0 ? tp / retained : 0;
    const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;

    return { threshold, recall, precision, f1, docs_retained: retained, docs_dropped: dropped, true_positives: tp, false_negatives: fn };
  }

  // Coarse sweep
  const coarseResults = coarseCandidates.map(evaluateThreshold);

  // Find region of interest: around where recall crosses 75%
  const recallTarget = 0.75;
  let bestCoarse = coarseResults[0];
  for (const r of coarseResults) {
    if (r.recall >= recallTarget && r.threshold > bestCoarse.threshold) {
      bestCoarse = r;
    }
  }

  // Fine sweep: 0.1 increments around the best coarse point
  const fineCandidates: number[] = [];
  for (let t = bestCoarse.threshold - 2; t <= bestCoarse.threshold + 2; t += 0.1) {
    fineCandidates.push(Math.round(t * 10) / 10);
  }

  const fineResults = fineCandidates.map(evaluateThreshold);
  const allSweep = [...coarseResults, ...fineResults]
    .sort((a, b) => a.threshold - b.threshold)
    // Dedupe by threshold
    .filter((v, i, arr) => i === 0 || Math.abs(v.threshold - arr[i - 1].threshold) > 0.01);

  // Find recommended floor: most aggressive threshold with recall >= 75%
  const passingPoints = allSweep.filter(p => p.recall >= recallTarget);
  const recommendedFloor = passingPoints.length > 0
    ? passingPoints.reduce((best, p) => p.threshold > best.threshold ? p : best)
    : allSweep[0];

  // Find F1-optimal
  const f1Optimal = allSweep.reduce((best, p) => p.f1 > best.f1 ? p : best);

  // Tier thresholds: based on relevant score distribution
  // Strong = top ~30% of relevant scores
  // Partial = above floor but below strong
  const strongThreshold = relevantScores.length > 0 ? percentile(relevantScores, 70) : 3.0;
  const partialThreshold = relevantScores.length > 0 ? percentile(relevantScores, 25) : 0.0;

  // Print results
  console.log(`\n--- Sweep Results ---\n`);
  console.log(`${'Threshold'.padStart(10)} ${'Recall'.padStart(8)} ${'Precision'.padStart(10)} ${'F1'.padStart(8)} ${'Retained'.padStart(10)} ${'Dropped'.padStart(9)}`);
  console.log('-'.repeat(60));
  for (const p of allSweep) {
    const marker = Math.abs(p.threshold - recommendedFloor.threshold) < 0.01 ? ' ← FLOOR'
      : Math.abs(p.threshold - f1Optimal.threshold) < 0.01 ? ' ← F1-OPT'
      : '';
    console.log(
      `${p.threshold.toFixed(1).padStart(10)} ${(p.recall * 100).toFixed(1).padStart(7)}% ${(p.precision * 100).toFixed(1).padStart(9)}% ${(p.f1 * 100).toFixed(1).padStart(7)}% ${String(p.docs_retained).padStart(10)} ${String(p.docs_dropped).padStart(9)}${marker}`
    );
  }

  console.log(`\n--- Recommendations ---\n`);
  console.log(`  Floor (recall >= 75%): ${recommendedFloor.threshold.toFixed(2)} → recall=${(recommendedFloor.recall * 100).toFixed(1)}%, precision=${(recommendedFloor.precision * 100).toFixed(1)}%`);
  console.log(`  F1-optimal:           ${f1Optimal.threshold.toFixed(2)} → recall=${(f1Optimal.recall * 100).toFixed(1)}%, precision=${(f1Optimal.precision * 100).toFixed(1)}%, F1=${(f1Optimal.f1 * 100).toFixed(1)}%`);
  console.log(`  Strong threshold:     ${strongThreshold.toFixed(2)} (p70 of relevant scores)`);
  console.log(`  Partial threshold:    ${partialThreshold.toFixed(2)} (p25 of relevant scores)`);

  // Save report
  const report: CalibrationReport = {
    timestamp: new Date().toISOString(),
    mode: 'cite',
    golden_queries: testCases.length,
    golden_expected_docs: totalExpected,
    total_retrieved_docs: allDocs.length,
    recommended: {
      floor: Math.round(recommendedFloor.threshold * 100) / 100,
      floor_recall: Math.round(recommendedFloor.recall * 1000) / 1000,
      floor_precision: Math.round(recommendedFloor.precision * 1000) / 1000,
      strong_threshold: Math.round(strongThreshold * 100) / 100,
      partial_threshold: Math.round(partialThreshold * 100) / 100,
    },
    f1_optimal: {
      floor: Math.round(f1Optimal.threshold * 100) / 100,
      recall: Math.round(f1Optimal.recall * 1000) / 1000,
      precision: Math.round(f1Optimal.precision * 1000) / 1000,
      f1: Math.round(f1Optimal.f1 * 1000) / 1000,
    },
    sweep_data: allSweep,
    score_distribution: {
      relevant: {
        min: relevantScores[0] ?? 0,
        max: relevantScores[relevantScores.length - 1] ?? 0,
        median: percentile(relevantScores, 50),
        p25: percentile(relevantScores, 25),
        p75: percentile(relevantScores, 75),
      },
      not_relevant: {
        min: notRelevantScores[0] ?? 0,
        max: notRelevantScores[notRelevantScores.length - 1] ?? 0,
        median: percentile(notRelevantScores, 50),
        p25: percentile(notRelevantScores, 25),
        p75: percentile(notRelevantScores, 75),
      },
    },
  };

  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(resultsDir, `cite-threshold-calibration-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${outPath}`);
}

main().catch(err => {
  console.error('Calibration failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script**

In `package.json`, add to `"scripts"`:
```json
"eval:calibrate-cite": "npx tsx --env-file-if-exists=.env evaluation/calibrate-cite-thresholds.ts"
```

- [ ] **Step 3: Test the script runs**

Run: `npm run eval:calibrate-cite`
Expected: Script connects to search service, runs 11 queries, prints sweep table and recommendations, saves JSON report to `evaluation/results/`.

**Prerequisites:** Search service must be running on :8000.

- [ ] **Step 4: Commit**

```bash
git add evaluation/calibrate-cite-thresholds.ts package.json
git commit -m "feat(eval): add cite logit threshold calibration script"
```

---

### Task 2: Search Service — Config and DocumentResult Schema

**Files:**
- Modify: `search-service/app/config.py:5-28` (Settings class)
- Modify: `search-service/app/main.py:156-163` (DocumentResult model)

- [ ] **Step 1: Add threshold config values to Settings**

In `search-service/app/config.py`, add these fields inside the `Settings` class, after the SSL fields (line 28):

```python
    # Cite mode relevance thresholds (calibrated against cross-encoder/ms-marco-MiniLM-L-6-v2)
    cite_logit_floor: float = -5.37       # Raw score floor — results below this are dropped
    cite_strong_threshold: float = 3.0    # Raw score >= this → "strong" tier
    cite_partial_threshold: float = 0.0   # Raw score >= this → "partial" tier (below → "weak")
```

These are placeholder defaults. After running calibration (Task 1, Step 3), update with the actual recommended values.

- [ ] **Step 2: Add `relevance_tier` to DocumentResult**

In `search-service/app/main.py`, add `relevance_tier` field to the `DocumentResult` model at line 163:

```python
class DocumentResult(BaseModel):
    doc_id: str
    title: str
    content: str
    score: float
    metadata: Dict[str, Any]
    page: Optional[int] = None
    chunk_id: Optional[str] = None
    relevance_tier: str = ""  # "strong" | "partial" | "weak"
```

- [ ] **Step 3: Commit**

```bash
git add search-service/app/config.py search-service/app/main.py
git commit -m "feat(service): add cite threshold config and relevance_tier to DocumentResult"
```

---

### Task 3: Search Service — Logit Floor and Tier Assignment

**Files:**
- Modify: `search-service/app/main.py:1110-1177` (pipeline stages 2.1 through normalization)

The changes go in the pipeline between Stage 2 (reranking) and Stage 2.5 (metadata filters). We insert floor filtering and tier assignment, renumber page-1 demotion, and remove the cite-mode `[0.15, 1.0]` remap.

- [ ] **Step 1: Verify settings import exists in main.py**

Check if `get_settings` is already imported:
Run: `grep -n "from app.config" search-service/app/main.py`

If not found, add near the top of `main.py` (after existing imports):

```python
from app.config import get_settings
```

- [ ] **Step 2: Add logit floor and tier assignment after reranking**

After Stage 2 reranking (line 1110: `stage2_results = stage1_results`) and before the current Stage 2.1 page-1 demotion (line 1112), insert:

```python
        # Stage 2.1: Logit Floor (cite mode only)
        # Drop results below the raw score floor to remove genuinely irrelevant results
        # before normalization destroys the absolute signal.
        if request.mode == "cite" and stage2_results:
            settings = get_settings()
            floor = settings.cite_logit_floor
            pre_floor_count = len(stage2_results)
            stage2_results = [r for r in stage2_results if float(r.score) >= floor]
            logger.info(f"Stage 2.1 (Logit Floor): {pre_floor_count} -> {len(stage2_results)} results (floor={floor})")

        # Stage 2.2: Tier Assignment (cite mode only)
        # Tag each surviving result with a relevance tier based on raw score.
        # Tier strings are passed to the frontend for display — no threshold
        # logic needed in JS.
        cite_tiers = {}  # node_id -> tier string
        if request.mode == "cite" and stage2_results:
            settings = get_settings()
            strong_t = settings.cite_strong_threshold
            partial_t = settings.cite_partial_threshold
            for node in stage2_results:
                raw = float(node.score)
                if raw >= strong_t:
                    cite_tiers[node.node.node_id] = "strong"
                elif raw >= partial_t:
                    cite_tiers[node.node.node_id] = "partial"
                else:
                    cite_tiers[node.node.node_id] = "weak"
```

We store tiers in a dict keyed by node_id because `node.score` will be overwritten during normalization. The tier is assigned to the `DocumentResult` later.

- [ ] **Step 3: Renumber page-1 demotion to Stage 2.3**

Change the existing comment at line 1112 from:
```python
        # Stage 2.1: Page-1 demotion for answer mode (abstracts → lower priority)
```
to:
```python
        # Stage 2.3: Page-1 demotion for answer mode (abstracts → lower priority)
```

And the log line from:
```python
            logger.info(f"Stage 2.1 (Page-1 Demotion): applied to answer mode")
```
to:
```python
            logger.info(f"Stage 2.3 (Page-1 Demotion): applied to answer mode")
```

- [ ] **Step 4: Remove cite-mode [0.15, 1.0] remap**

In the normalization section (around line 1170), remove the cite-mode remap block:

```python
                # Mode-specific adjustment:
                # - Answer mode: Use full [0, 1] range for strong signal separation
                # - Cite mode: Apply relevance floor [0.15, 1.0] to show all results have some relevance
                if request.mode == "cite" and normalized_score < 1.0:
                    # Map [0, 1] → [0.15, 1.0] so minimum score is 0.15 instead of 0
                    normalized_score = 0.15 + (normalized_score * 0.85)
```

Replace with a comment:

```python
                # Note: cite-mode [0.15, 1.0] remap removed — logit floor (Stage 2.1)
                # now handles dropping irrelevant results before normalization.
```

- [ ] **Step 5: Set relevance_tier on DocumentResult**

In the doc construction section (around line 1217), add the tier to the `DocumentResult`:

Change:
```python
            doc_result = DocumentResult(
                doc_id=metadata.get("doc_id", "unknown"),
                chunk_id=metadata.get("chunk_id", "unknown"),
                title=metadata.get("title", "Untitled"),
                content=content,
                score=round(normalized_score, 4),
                metadata={**metadata, "raw_score": raw_score},
                page=metadata.get("page", 1)
            )
```

To:
```python
            doc_result = DocumentResult(
                doc_id=metadata.get("doc_id", "unknown"),
                chunk_id=metadata.get("chunk_id", "unknown"),
                title=metadata.get("title", "Untitled"),
                content=content,
                score=round(normalized_score, 4),
                metadata={**metadata, "raw_score": raw_score},
                page=metadata.get("page", 1),
                relevance_tier=cite_tiers.get(node_with_score.node.node_id, "")
            )
```

- [ ] **Step 6: Verify service starts**

Run: `cd search-service && source venv/bin/activate && python -c "from app.main import app; print('OK')"`
Expected: `OK` (no import errors)

- [ ] **Step 7: Commit**

```bash
git add search-service/app/main.py
git commit -m "feat(service): add cite logit floor, tier assignment, remove score remap"
```

---

### Task 4: Frontend — Types and Utility Functions

**Files:**
- Modify: `src/lib/llamacloud.ts:9-15` (KP type)
- Modify: `src/app/components/results/types.ts:3-17` (RowData type)
- Modify: `src/app/utils/relevance.ts` (full rewrite)

- [ ] **Step 1: Add `relevance_tier` and `raw_score` to KP type**

In `src/lib/llamacloud.ts`, change the KP type (lines 9-15) from:

```typescript
export type KP = {
  kp_relevance: number
  snippet: string
  passage_id: string
  page?: number
  citation_targets: CitationTarget[]
}
```

To:

```typescript
export type KP = {
  kp_relevance: number
  snippet: string
  passage_id: string
  page?: number
  citation_targets: CitationTarget[]
  relevance_tier?: string  // "strong" | "partial" | "weak"
  raw_score?: number
}
```

- [ ] **Step 2: Add `relevance_tier` and `raw_score` to RowData type**

In `src/app/components/results/types.ts`, add to the `RowData` type (after `relevance_score` on line 12):

```typescript
  relevance_tier?: string  // "strong" | "partial" | "weak"
  raw_score?: number
```

- [ ] **Step 3: Rewrite relevance.ts**

Replace the contents of `src/app/utils/relevance.ts` with:

```typescript
/**
 * Map relevance tier strings (from search service) to display labels and colors.
 * Tiers are assigned by the Python service based on raw reranker logits.
 * No threshold logic lives in the frontend.
 */

// Accept string | number for backward compat.
// Cite mode passes tier strings ("strong"/"partial"/"weak").
// Answer mode (SupportingCitations.tsx) still passes numeric kp_relevance.
export function getRelevanceLevel(tierOrScore: string | number): string {
  if (typeof tierOrScore === 'number') {
    return tierOrScore.toFixed(2).toString()
  }
  switch (tierOrScore) {
    case 'strong': return 'Strong Match'
    case 'partial': return 'Partial Match'
    case 'weak': return 'Weak Match'
    default: return tierOrScore || '0.00'
  }
}

export function getRelevanceColor(tier: string): string {
  switch (tier) {
    case 'strong': return '#22c55e'   // green
    case 'partial': return '#f59e0b'  // amber
    case 'weak': return '#94a3b8'     // slate gray
    default: return '#22c55e'         // fallback green (backward compat)
  }
}

export function getRelevanceVariant(tier: string): 'success' | 'warning' | 'info-grey' {
  switch (tier) {
    case 'strong': return 'success'
    case 'partial': return 'warning'
    case 'weak': return 'info-grey'
    default: return 'success'
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/llamacloud.ts src/app/components/results/types.ts src/app/utils/relevance.ts
git commit -m "feat(frontend): add relevance tier types and utility functions"
```

---

### Task 5: Frontend — Cite Route Passthrough

**Files:**
- Modify: `src/app/api/llamaindex/route.ts:131-199`

- [ ] **Step 0: Add `relevance_tier` to `LlamaIndexResponse` interface**

In `src/app/api/llamaindex/route.ts`, add `relevance_tier` to the `LlamaIndexResponse` interface (line 23-36). Change:

```typescript
interface LlamaIndexResponse {
  docs: Array<{
    doc_id: string
    title: string
    content: string
    score: number
    metadata: Record<string, any>
    page?: number
  }>
```

To:

```typescript
interface LlamaIndexResponse {
  docs: Array<{
    doc_id: string
    title: string
    content: string
    score: number
    metadata: Record<string, any>
    page?: number
    relevance_tier?: string
  }>
```

- [ ] **Step 1: Remove `CITE_SCORE_FLOOR` filtering, pass through tier and raw_score**

Replace the filtering block (lines 131-158) with:

```typescript
    // Cite mode: cap at MAX_DOCS, keep MIN_DOCS safety net
    // Floor filtering now happens in the search service (logit floor on raw scores)
    const CITE_MIN_DOCS = 12
    const CITE_MAX_DOCS = 32

    let filteredDocs: typeof llamaIndexResponse.docs
    if (mode === 'cite') {
      filteredDocs = llamaIndexResponse.docs.slice(0, CITE_MAX_DOCS)
      // Safety net: if service returned fewer than MIN_DOCS, keep all
      if (filteredDocs.length < CITE_MIN_DOCS && llamaIndexResponse.docs.length > filteredDocs.length) {
        filteredDocs = llamaIndexResponse.docs.slice(0, CITE_MIN_DOCS)
      }
    } else {
      filteredDocs = llamaIndexResponse.docs
    }

    console.log(
      `[LlamaIndex API] After filtering (${mode === 'cite' ? `min=${CITE_MIN_DOCS}, max=${CITE_MAX_DOCS}` : 'none'}): ${filteredDocs.length}/${llamaIndexResponse.docs.length} docs`,
    )
```

- [ ] **Step 2: Pass `relevance_tier` and `raw_score` in the doc mapping**

In the doc mapping (starting at line 161), update the KP construction to pass through tier and raw_score. Change the kps array in the return object from:

```typescript
        kps: [
          {
            kp_relevance: effectiveScore,
            snippet: doc.content,
```

To include `relevance_tier` and `raw_score`:

```typescript
        kps: [
          {
            kp_relevance: effectiveScore,
            relevance_tier: doc.relevance_tier || '',
            raw_score: doc.metadata?.raw_score,
            snippet: doc.content,
```

Note: Do NOT add `relevance_tier` or `raw_score` at the doc level — `DocMeta` doesn't have those fields. The KP-level fields are what CitePanel reads.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/llamaindex/route.ts
git commit -m "feat(frontend): remove cite score floor, pass through relevance tier"
```

---

### Task 6: Frontend — CitePanel and SelectableResultRow

**Files:**
- Modify: `src/app/results/CitePanel.tsx:60-97`
- Modify: `src/app/components/results/SelectableResultRow.tsx:152-158`

- [ ] **Step 1: Pass tier and raw_score through CitePanel's RowData mapping**

In `src/app/results/CitePanel.tsx`, in the `tableData` mapping (around line 77-96), update the return object to include tier and raw_score. After `relevance: relevanceLabel,` add:

```typescript
          relevance_tier: doc.kps?.[0]?.relevance_tier || '',
          raw_score: doc.kps?.[0]?.raw_score,
```

Also update the `relevanceLabel` computation. Change:

```typescript
        const relevanceLabel = getRelevanceLevel(docRel)
```

To:

```typescript
        const tier = doc.kps?.[0]?.relevance_tier || ''
        const relevanceLabel = tier ? getRelevanceLevel(tier) : getRelevanceLevel(docRel.toFixed(2))
```

This provides backward compatibility: if the service returns a tier, use it; otherwise fall back to the numeric score display.

- [ ] **Step 2: Update CitePanel import**

At the top of `src/app/results/CitePanel.tsx`, update the import from relevance.ts. If it currently imports `getRelevanceLevel` only, keep that. If it needs `getRelevanceColor` or `getRelevanceVariant`, add those too.

Check current import:
```
grep -n "relevance" src/app/results/CitePanel.tsx | head -5
```

- [ ] **Step 3: Update SelectableResultRow to use tier-based badge**

In `src/app/components/results/SelectableResultRow.tsx`, change the relevance badge (lines 152-158) from:

```typescript
      <TableCell width={120}>
        <div style={{ width: 'fit-content' }}>
          <Tooltip content='How relevant this document is compared with other results for this query. The top result is scaled to 1.0'>
            <Tag label={rowData.relevance} variant='success' />
          </Tooltip>
        </div>
      </TableCell>
```

To:

```typescript
      <TableCell width={120}>
        <div style={{ width: 'fit-content' }}>
          <Tooltip content={rowData.raw_score != null ? `Raw reranker score: ${rowData.raw_score.toFixed(2)}` : 'Relevance tier based on reranker confidence'}>
            <Tag label={rowData.relevance} variant={getRelevanceVariant(rowData.relevance_tier || '')} />
          </Tooltip>
        </div>
      </TableCell>
```

Add the import at the top of the file:

```typescript
import { getRelevanceVariant } from '../../utils/relevance'
```

- [ ] **Step 4: Update DocumentPreviewModal.tsx**

In `src/app/components/results/DocumentPreviewModal.tsx` (line 14), update the hardcoded Tag to use the tier variant. Change:

```typescript
      <Tag label={`${rowData.relevance} Relevance`} variant='success' />
```

To:

```typescript
      <Tag label={`${rowData.relevance}`} variant={getRelevanceVariant(rowData.relevance_tier || '')} />
```

Add the import:
```typescript
import { getRelevanceVariant } from '../../utils/relevance'
```

- [ ] **Step 5: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add src/app/results/CitePanel.tsx src/app/components/results/SelectableResultRow.tsx src/app/components/results/DocumentPreviewModal.tsx
git commit -m "feat(frontend): display relevance tiers with color-coded badges and raw score tooltips"
```

---

### Task 7: Validation

**Files:** No new files

- [ ] **Step 1: Run cite eval**

Run: `npm run eval:cite`
Expected: Recall >= 75%, no regression on individual queries. Note that results will differ from baseline because the logit floor now drops irrelevant docs before normalization.

- [ ] **Step 2: Check CITE_MIN_DOCS safety net**

In the eval output or by running a few queries manually, check if any query returns fewer than 12 docs after the logit floor. If none do, the safety net is unnecessary (can be removed in a follow-up).

Run: `curl -s -X POST http://localhost:8000/query -H 'Content-Type: application/json' -d '{"query":"What have we published on Bangalore?","mode":"cite","rerank":true}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Docs returned: {len(d[\"docs\"])}')""`

Repeat for 2-3 other golden queries.

- [ ] **Step 3: Spot-check tier assignments**

Run a query and inspect the tiers:

```bash
curl -s -X POST http://localhost:8000/query -H 'Content-Type: application/json' \
  -d '{"query":"What have we published on land value capture?","mode":"cite","rerank":true}' \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
for doc in d['docs'][:10]:
    print(f'{doc[\"relevance_tier\"]:8s} raw={doc[\"metadata\"][\"raw_score\"]:7.2f} norm={doc[\"score\"]:.4f} {doc[\"title\"][:60]}')
"
```

Expected: Docs with high raw scores show "strong", lower ones show "partial" or "weak". No docs below the floor appear.

- [ ] **Step 4: Commit any threshold adjustments**

If calibration results (Task 1) suggest different values than the placeholders in config.py, update them now:

```bash
git add search-service/app/config.py
git commit -m "chore: set calibrated cite threshold values from sweep"
```
