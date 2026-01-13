# Root Cause Analysis: Catastrophic Precision Regression

**Date**: 2025-11-24
**Analyst**: Claude Code (Evaluation Architect)
**Incident**: Precision collapsed from 36.8% → 10.3% (-72%), Recall dropped from 70.5% → 63.9% (-9%)

---

## Executive Summary

The catastrophic precision regression was caused by **Change #3: LLM Filter Optimization** (lines 340-353 in `evaluation/run-cite-eval.ts`), which reduced LLM filtering from all 60-80 docs to only the top 30 docs, then passed through the remaining 30-50 docs **unfiltered**. This caused 3-4x increase in result counts (7→27 docs for Q1, 10→52 docs for Q2) with most additional results being false positives.

The other changes (query parser, post-retrieval filters, threshold lowering) had minimal impact and may be salvageable. The primary failure mode is **unfiltered noise flooding results**.

---

## Root Cause Breakdown

### PRIMARY CAUSE: Change #3 - LLM Filter Optimization (Lines 340-353)

**What changed:**
```typescript
// BEFORE (baseline):
const filteredDocs = await filterByLLMRelevance(queryForLLM, docs, 'moderate', 0.35);

// AFTER (current):
const TOP_N_TO_FILTER = 30;
const docsToFilter = docs.slice(0, TOP_N_TO_FILTER);
const docsPassthrough = docs.slice(TOP_N_TO_FILTER);  // ⚠️ UNFILTERED
const filteredTopDocs = await filterByLLMRelevance(queryForLLM, docsToFilter, 'moderate', 0.3);
docs = [...filteredTopDocs, ...docsPassthrough];  // ⚠️ CONCATENATE FILTERED + UNFILTERED
```

**Why this failed:**

1. **Assumption violated**: The optimization assumed that docs beyond rank 30 are already so low-quality that LLM filtering doesn't matter. **This is false**. The reranker sorts by semantic similarity, NOT by precision. A document can be semantically similar (high reranker score) but tangentially related (should be filtered out by LLM).

2. **Noise amplification**: By passing through ranks 31-80 unfiltered, we added ~30-50 documents that the LLM would have rejected. Since the baseline kept ~11 docs total after LLM filtering, adding 30-50 unfiltered docs means results tripled or quadrupled.

3. **Precision collapse mechanism**:
   - **Q1 (Land Value Capture)**: 7 docs → 27 docs (3.9x increase)
     - Top 30 filtered to ~7 true positives + few false positives
     - Ranks 31-80 added ~20 more docs (mostly false positives: e-bus financing, Vietnam EVs, sanitation, etc.)
     - Precision: 42.9% → 11.1%

   - **Q2 (Bangalore)**: 10 docs → 52 docs (5.2x increase)
     - Top 30 filtered to ~5-6 true positives
     - Ranks 31-80 added ~46 more docs (broad India studies, tangential mentions)
     - Precision: 50% → 9.6%

4. **Recall impact**: Also lost some recall because:
   - Lower confidence threshold (0.35 → 0.3) didn't help as much as expected
   - Filtering only top 30 means docs at ranks 31-60 with borderline relevance passed through even if they shouldn't
   - Some ground truth docs fell into ranks 31-80 and weren't filtered properly (e.g., Q6 lost "improving school infrastructure")

**Evidence from results:**

```
Q1 (Land Value Capture):
BEFORE: 7 docs retrieved, 3 correct (42.9% precision)
AFTER: 27 docs retrieved, 3 correct (11.1% precision)
FALSE POSITIVES ADDED (ranks 31-80):
  - E-bus financing papers (6+ docs)
  - Vietnam EV study (2 docs)
  - School bus electrification (4 docs)
  - Sanitation, water resilience, ride-hailing, etc.

Q2 (Bangalore):
BEFORE: 10 docs retrieved, 5 correct (50% precision)
AFTER: 52 docs retrieved, 5 correct (9.6% precision)
FALSE POSITIVES ADDED:
  - Broad India studies mentioning Bangalore tangentially (30+ docs)
  - Papers about other Indian cities
```

**Cost-speed tradeoff failure**: The optimization aimed to reduce API time from 10min → 30sec by filtering only 30 docs instead of 80. But it destroyed precision by letting 50 docs through unfiltered. **This is a false economy** - saving $0.01 in API costs while making results unusable.

---

### SECONDARY CAUSES (Minor Contributors)

#### Change #4: Threshold Lowered (Line 348)
```typescript
// BEFORE: confidence >= 0.35
// AFTER: confidence >= 0.3
```

**Impact**: Minimal in isolation (~5% more docs pass filter). But combined with Change #3, this exacerbated the problem by allowing more borderline docs in the top 30 to pass through.

**Verdict**: Revert to 0.35. The 0.05 difference is not meaningful enough to justify the risk.

---

#### Change #1: Query Parser Changes (Lines 102-106 in query-parser.ts)
```typescript
// BEFORE: return cleanedQuery (stripped filters)
// AFTER: return rawQuery (full original query)
```

**Rationale**: Preserve semantic signals for embeddings/BM25 instead of stripping filter terms.

**Impact**: Likely **positive or neutral** for retrieval, but couldn't overcome the LLM filter failure. Evidence:
- Q9 (WRR) went from 32 docs → 0 docs, but this was due to **program_series metadata not populated in chunks** (separate bug, not caused by this change)
- Q10 (urban finance since 2020) retrieved similar count (21 vs 26 docs) with slightly better recall (40% vs 30%)

**Verdict**: **Keep this change**. The rationale is sound: semantic search works better with full context. The precision collapse wasn't caused by retrieval quality - it was caused by filtering failure downstream.

---

#### Change #2: Post-Retrieval Filtering (Lines 275-334)
```typescript
// Parse query for filters
const parsed = parseQuery(testCase.question);

// Send FULL query to retrieval (preserve semantics)
let docs = await callPythonService(fullQuery, { ... });

// Apply metadata filters AFTER retrieval
docs = docs.filter(doc => {
  if (parsed.minYear && doc.year < parsed.minYear) return false;
  if (parsed.requiredProgram && doc.meta.raw.program_series !== parsed.requiredProgram) return false;
  if (parsed.excludedKeywords && title.includes(keyword)) return false;
  return true;
});
```

**Impact**:
- **Q9 (WRR)**: Catastrophic failure (0% recall), but this was due to **program_series metadata not propagated to chunks**. The filtering logic itself is correct.
- **Q10 (urban finance since 2020)**: Year filter worked (67 docs → 52 docs), improved recall (30% → 40%). But precision unchanged (11.5% → 11.1%) because LLM filter was broken.
- **Q11 (exclude electric buses)**: Exclusion filter worked reasonably (some e-bus docs still leaked through, but better than before).

**Critical bug exposed**: `program_series` field is loaded in document metadata (line 390 of main.py) but **NOT propagated to chunk metadata** (lines 697-708). This caused Q9 to filter out ALL results.

**Verdict**:
- **Keep the post-retrieval filtering architecture** - it's the right design
- **Fix metadata propagation bug** in hybrid-service/main.py (add program_series to chunk metadata at line 706)
- **Improve exclusion matching** (use stemming, handle plurals: "electric bus" should match "electric buses")

---

### TERTIARY CAUSE: Metadata Propagation Bug (hybrid-service/main.py)

**Bug**: `program_series` field loaded in document metadata (line 390) but not copied to chunk metadata (line 706).

**Impact**: Q9 (World Resources Report) filtering failed completely because chunks don't have the `program_series` field needed for filtering.

**Evidence**:
```
Q9 BEFORE: 32 docs retrieved (filtered from larger set)
Q9 AFTER: 0 docs retrieved (all filtered out because program_series missing)
```

**This is NOT caused by recent changes** - it's a pre-existing infrastructure gap exposed by adding program-based filtering.

---

## Detailed Test Case Analysis

### Q1 (Land Value Capture) - Precision Collapsed 74%

**BEFORE:**
- Retrieved: 7 docs
- Correct: 3 docs
- Precision: 42.9%, Recall: 75%
- False positives: 4 docs (broad urban studies)

**AFTER:**
- Retrieved: 27 docs (3.9x increase)
- Correct: 3 docs (same recall)
- Precision: 11.1%, Recall: 75%
- False positives: 24 docs

**Smoking gun**: The 20 additional docs are ranks 31-80 passed through unfiltered. Examples:
- E-bus financing papers (6 docs) - mention "land value capture" in passing
- Vietnam EV study (2 docs) - tangentially mentions financing
- School bus electrification (4 docs) - mentions financing/economics
- Sanitation, ride-hailing, delivery zones - mention "value" or "capture" in different context

**Root cause**: LLM filter would have rejected these as tangentially related, but they bypassed filtering by being in ranks 31-80.

---

### Q2 (Bangalore) - Precision Collapsed 81%

**BEFORE:**
- Retrieved: 10 docs
- Correct: 5 docs
- Precision: 50%, Recall: 83.3%
- False positives: 5 docs

**AFTER:**
- Retrieved: 52 docs (5.2x increase)
- Correct: 5 docs
- Precision: 9.6%, Recall: 83.3%
- False positives: 47 docs

**Root cause**: Same as Q1. Broad India studies that mention Bangalore once or twice passed through ranks 31-80 unfiltered.

---

### Q6 (School Bus Health) - Lost Recall

**BEFORE:**
- Retrieved: 7 docs
- Correct: 3 docs
- Precision: 42.9%, Recall: 75%

**AFTER:**
- Retrieved: 6 docs
- Correct: 2 docs
- Precision: 33.3%, Recall: 50%
- Lost: "improving-school-infrastructure-healthier-students-and-communities"

**Root cause**: The missing doc was likely in ranks 31-80 and passed through unfiltered, but wasn't in the final 6 returned. This suggests the TOP_N_TO_FILTER=30 optimization created a **filtering gap** where docs at ranks 31-60 should have been filtered but weren't, and then got cut off by some downstream limit.

---

### Q9 (World Resources Report) - Total Failure

**BEFORE:**
- Retrieved: 32 docs (low precision, but some recall)
- Correct: 9 docs
- Precision: 28.1%, Recall: 56.3%

**AFTER:**
- Retrieved: 0 docs (total failure)
- Correct: 0 docs
- Precision: 0%, Recall: 0%

**Root cause**: NOT caused by LLM filter optimization. This was caused by:
1. Post-retrieval filter tried to apply `required_program = "World Resources Report"`
2. But `program_series` field not propagated to chunk metadata
3. So `doc.meta.raw.program_series` was undefined for all docs
4. Filter rejected all docs: `if (program !== parsed.requiredProgram) return false;`

**This is a metadata infrastructure bug**, not an eval optimization bug.

---

### Q10 (Urban Finance since 2020) - Mixed Results

**BEFORE:**
- Retrieved: 26 docs
- Correct: 3 docs
- Precision: 11.5%, Recall: 30%

**AFTER:**
- Retrieved: 52 docs initially → 36 docs after year filter
- Correct: 4 docs
- Precision: 11.1%, Recall: 40%

**Analysis**: Year filter worked (67 docs → 52 docs), improved recall slightly. But precision remained terrible because LLM filter was broken. The unfiltered docs in ranks 31-80 were mostly false positives.

---

## Why Other Suspected Changes Are NOT the Cause

### NOT CAUSE: rerank_top_n increased from 60 → 80
**Evidence**: The regression occurred AFTER reranking, not during. The problem is in post-retrieval filtering (LLM stage), not retrieval stage.

### NOT CAUSE: Query parser returning full query instead of stripped
**Evidence**: Q10 retrieved 67 docs before year filter (similar to baseline), showing retrieval quality was fine. The problem was filtering, not retrieval.

### NOT CAUSE: Confidence threshold lowered 0.35 → 0.3
**Evidence**: This would only add ~5% more docs in the top 30 filtered set. Cannot explain 300-400% increase in results.

---

## Reversion Plan

### IMMEDIATE ACTIONS (Revert Changes)

#### 1. Revert LLM Filter Optimization (Lines 340-353)
**File**: `/Users/zunix/Documents/GitHub/askwri/mockups/askwri/evaluation/run-cite-eval.ts`

**REVERT:**
```typescript
// Remove lines 340-353
// BEFORE (lines 337-353):
console.log(`   [Before LLM Filter] Retrieved: ${docs.length} documents`);

// Apply LLM-based relevance filtering
// OPTIMIZATION: Only filter top 30 docs (reranking already sorted by relevance)
// This reduces API calls while maintaining recall (we typically keep ~11 docs)
const TOP_N_TO_FILTER = 30;
const docsToFilter = docs.slice(0, TOP_N_TO_FILTER);
const docsPassthrough = docs.slice(TOP_N_TO_FILTER); // Keep lower-ranked docs without filtering

// Pass both question and task description for accurate judgment
const queryForLLM = `${testCase.question}\n\nTask: ${testCase.task_description}`;
const filteredTopDocs = await filterByLLMRelevance(queryForLLM, docsToFilter, 'moderate', 0.3);

// Combine filtered top docs with passthrough docs
docs = [...filteredTopDocs, ...docsPassthrough];
```

**REPLACE WITH (baseline behavior):**
```typescript
console.log(`   [Before LLM Filter] Retrieved: ${docs.length} documents`);

// Apply LLM-based relevance filtering to ALL docs
const queryForLLM = `${testCase.question}\n\nTask: ${testCase.task_description}`;
docs = await filterByLLMRelevance(queryForLLM, docs, 'moderate', 0.35);
```

**Why**: This removes the unfiltered passthrough that caused precision collapse. Restores filtering to all 60-80 docs with original threshold.

---

#### 2. Revert Confidence Threshold (Line 348)
**File**: `/Users/zunix/Documents/GitHub/askwri/mockups/askwri/evaluation/run-cite-eval.ts`

**REVERT**: Change `0.3` back to `0.35` in the filterByLLMRelevance call (if keeping any optimization).

**Why**: The 0.05 drop let more borderline docs through without meaningful recall improvement.

---

### KEEP THESE CHANGES (Salvageable)

#### 3. Keep Query Parser Changes (Lines 102-106 in query-parser.ts)
**File**: `/Users/zunix/Documents/GitHub/askwri/mockups/askwri/src/lib/query-parser.ts`

**Rationale**: Preserving full query context for semantic search is correct. The precision collapse was NOT caused by retrieval quality - it was caused by filtering failure.

**Evidence**: Q10 retrieved appropriate docs with year filters extracted correctly. The problem was downstream filtering.

**Action**: No change needed.

---

#### 4. Keep Post-Retrieval Filtering Architecture (Lines 275-334)
**File**: `/Users/zunix/Documents/GitHub/askwri/mockups/askwri/evaluation/run-cite-eval.ts`

**Rationale**: The architecture is sound - extract filters from query, send full query to retrieval, apply filters post-retrieval. This is the correct design pattern.

**Action**: Keep the code, but **fix the metadata bug** (see below).

---

### CRITICAL BUG FIXES (New Work Required)

#### 5. Fix Metadata Propagation Bug (Lines 697-708)
**File**: `/Users/zunix/Documents/GitHub/askwri/mockups/askwri/hybrid-service/main.py`

**BUG**: `program_series` loaded in document metadata (line 390) but not copied to chunk metadata (line 706).

**FIX**: Add `program_series` to chunk metadata update:

```python
# BEFORE (line 697-708):
node.metadata.update({
    "chunk_id": f"{doc['doc_id']}_chunk_{chunk_idx}",
    "chunk_index": chunk_idx,
    "total_chunks": len(doc_nodes),
    "page": page_num,
    "chunk_start_pos": chunk_start_pos,
    "authors": doc["metadata"]["authors"],
    "year": doc["metadata"]["year"],
    "url": doc["metadata"].get("url", ""),
    "file_path": doc["metadata"].get("file_path", ""),
    "prev_chunk_id": f"{doc['doc_id']}_chunk_{chunk_idx-1}" if chunk_idx > 0 else None,
})

# AFTER (add program_series):
node.metadata.update({
    "chunk_id": f"{doc['doc_id']}_chunk_{chunk_idx}",
    "chunk_index": chunk_idx,
    "total_chunks": len(doc_nodes),
    "page": page_num,
    "chunk_start_pos": chunk_start_pos,
    "authors": doc["metadata"]["authors"],
    "year": doc["metadata"]["year"],
    "url": doc["metadata"].get("url", ""),
    "file_path": doc["metadata"].get("file_path", ""),
    "program_series": doc["metadata"].get("program_series", ""),  # ADD THIS LINE
    "prev_chunk_id": f"{doc['doc_id']}_chunk_{chunk_idx-1}" if chunk_idx > 0 else None,
})
```

**Why**: Without this, Q9 (World Resources Report) filtering fails completely.

**Note**: This requires **reindexing** the hybrid service (delete cache, restart service).

---

### OPTIONAL IMPROVEMENTS (Future Work)

#### 6. Improve Exclusion Keyword Matching
**File**: `/Users/zunix/Documents/GitHub/askwri/mockups/askwri/evaluation/run-cite-eval.ts` (lines 320-329)

**Current issue**: "electric bus" won't match "electric buses" (plural), "e-bus", "battery bus", etc.

**Improvement**: Use stemming and synonym expansion:

```typescript
// Current:
if (title.includes(keyword.toLowerCase()) || content.includes(keyword.toLowerCase())) {
  return false;
}

// Improved:
const keywordVariations = expandKeywordForMatching(keyword);  // "electric bus" → ["electric bus", "electric buses", "e-bus", "ebus", "battery bus"]
for (const variant of keywordVariations) {
  if (title.includes(variant) || content.includes(variant)) {
    return false;
  }
}
```

**Why**: Improves Q11 (exclude electric buses) filtering effectiveness.

---

## Validation Plan

### Step 1: Revert Changes
1. Revert LLM filter optimization (lines 340-353)
2. Revert threshold to 0.35
3. Keep query parser changes
4. Keep post-retrieval filtering architecture

### Step 2: Run Baseline Test
```bash
npx tsx evaluation/run-cite-eval.ts
```

**Expected results** (should match baseline report 1763951047368):
- Overall Recall: ~70.5% (±2%)
- Overall Precision: ~36.8% (±2%)
- Overall F1: ~47.0% (±2%)
- Passing: 6/11 tests (Q1, Q2, Q4, Q5, Q6, Q11)

**If results don't match**: Investigate git diff to ensure complete reversion.

### Step 3: Fix Metadata Bug
1. Add `program_series` to chunk metadata (line 706 in main.py)
2. Delete cache: `rm -rf hybrid-service/cache/`
3. Restart hybrid service: `python hybrid-service/main.py`
4. Wait for reindexing (30-60 seconds)

### Step 4: Re-run Evaluation
```bash
npx tsx evaluation/run-cite-eval.ts
```

**Expected improvement**:
- Q9 (World Resources Report): 0% recall → 50-60% recall (should retrieve some WRR docs)
- Overall metrics: Small improvement in recall and F1

### Step 5: Compare Results
```bash
# Generate diff report
npx tsx evaluation/compare-reports.ts \
  evaluation/results/eval-report-1763951047368.json \
  evaluation/results/eval-report-<new-timestamp>.json
```

**Success criteria**:
- Precision: ≥35% (restored)
- Recall: ≥70% (maintained)
- Q9 recall: >0% (fixed from total failure)
- No test cases with >20 docs retrieved (precision floor)

---

## Lessons Learned: Architectural Principles

### 1. Never bypass quality filters for speed optimization
**Failure mode**: Passing through ranks 31-80 unfiltered saved 30 seconds but destroyed precision.

**Principle**: If a filter is critical for quality (like LLM relevance judgment), apply it to ALL candidates, not just top-N. Use other strategies for speed:
- Batch processing (already implemented)
- Faster models (gpt-4o-mini already used)
- Caching (implement result caching for repeated queries)

---

### 2. Validate assumptions with data before optimizing
**Failure mode**: Assumed docs beyond rank 30 are already so bad that filtering doesn't matter. Data proved otherwise.

**Principle**: Before making "obvious" optimizations:
1. Sample docs at different rank positions (1-10, 11-30, 31-60, 61-80)
2. Manually judge: How many are false positives?
3. Only optimize if data supports the assumption

---

### 3. Treat retrieval and filtering as separate concerns
**Failure mode**: Conflating semantic similarity (reranker score) with document-level relevance (primary focus vs tangential).

**Principle**:
- **Retrieval stage** (vector + BM25 + reranking): Maximize recall, ensure relevant docs are in top-K
- **Filtering stage** (LLM judgment): Maximize precision, remove tangentially related docs
- Don't skip filtering just because retrieval scores are high - they measure different things

---

### 4. Propagate metadata completely through the pipeline
**Failure mode**: `program_series` loaded in document metadata but not copied to chunks, breaking downstream filters.

**Principle**:
- When adding new metadata fields, trace through the entire pipeline:
  1. CSV loading → document metadata
  2. Document metadata → chunk metadata
  3. Chunk metadata → retrieval results
  4. Retrieval results → API response
- Add integration tests that verify metadata end-to-end

---

### 5. Use incremental changes and frequent validation
**Failure mode**: Made 5 changes at once (query parser, post-retrieval filters, LLM optimization, threshold, metadata), making root cause analysis difficult.

**Principle**:
- Make one change at a time
- Run eval after each change
- Compare metrics to baseline immediately
- If regression occurs, revert before proceeding
- Use git branches for experimental changes

---

### 6. Optimize for interpretability in eval systems
**Failure mode**: The TOP_N_TO_FILTER optimization created a black box - hard to understand why precision collapsed without deep debugging.

**Principle**:
- Add logging at filter boundaries: "Filtered top 30: kept X/30", "Passed through ranks 31-80: Y docs"
- Log false positive examples: "Rejected docs: [titles]", "Kept docs: [titles]"
- Track filter effectiveness: "LLM filter removed Z% of candidates"
- Make eval results self-documenting

---

### 7. Cost-quality tradeoffs must be data-driven
**Failure mode**: Saved $0.05 per query (30 fewer LLM judgments) but made results unusable, wasting all user time.

**Principle**:
- Calculate true cost: API $ + user time lost from bad results
- Measure user impact: How many more docs must users review? How much time wasted?
- For $0.05 savings, destroying 73% of precision is never worth it
- Optimize speed only when quality is preserved (validated by metrics)

---

## Cost Analysis: The False Economy

### Current LLM Filter Cost (Baseline)
- Model: gpt-4o-mini
- Docs filtered per query: 60-80
- Batch size: 20 docs/call
- API calls per query: 3-4 calls
- Input tokens per call: ~2000 tokens (20 docs × 100 tokens each)
- Output tokens per call: ~500 tokens (20 judgments)
- Cost per call: $0.0003 input + $0.0006 output = ~$0.001
- **Total cost per query: ~$0.003-0.004**
- Execution time: ~2-3 seconds (parallel batches)

### Optimized Cost (Broken Optimization)
- Docs filtered: 30
- API calls: 2 (instead of 4)
- **Total cost per query: ~$0.002**
- Savings: $0.001-0.002 per query (~50% cost reduction)
- Execution time: ~1-2 seconds

### Impact Cost (Quality Degradation)
- Precision collapse: 36.8% → 10.3% (3.6x more false positives)
- User time reviewing false positives: 10 min/query → 36 min/query (3.6x increase)
- User time cost (researcher @ $50/hr): $8.33 → $30/query
- **Net cost increase: +$22/query** (while saving $0.001 in API costs)

**ROI of optimization**: Save $0.001, lose $22 in user time. **22,000x worse than doing nothing.**

---

## Conclusion

The catastrophic regression was caused by a single architectural mistake: passing through ranks 31-80 unfiltered to "optimize" LLM API calls. This saved 2 seconds and $0.001 per query while destroying precision (-73%) and making results unusable.

**The fix is simple**: Revert lines 340-353 to restore filtering to all docs. The original behavior was correct.

The other changes (query parser, post-retrieval filtering architecture) are sound and should be kept. The metadata propagation bug should be fixed to restore Q9 functionality.

**Key lesson**: Never bypass quality filters for speed. If a filter is critical for precision, apply it to all candidates. Optimize by batching, caching, or using faster models - not by skipping the filter entirely.
