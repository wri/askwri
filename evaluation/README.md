## AskWRI Evaluation System

**Current Status:** Speed optimization complete, recall target met, precision needs work.
**Last Updated:** 2025-11-26

## Quick Reference

**Run Evaluations:**
```bash
npm run eval:cite        # Full eval (11 queries, ~8 min)
npm run eval:quick       # Quick eval (3 queries, ~2 min)
npm run eval:report      # Generate report from latest results
```

**Current Performance (Nov 26):**
- **Precision:** ~16% (target: 35%)
- **Recall:** ~83% (target: 75%)
- **Pass Rate:** 6/11 queries (need recall ≥75% AND precision ≥15%)
- **Speed:** 40% faster evals (parallel batch processing)

## Evaluation Framework

### Test Queries (11 total)
Queries test different retrieval patterns:
- **Topic area** (Q1): Land value capture
- **Geography** (Q2): Bangalore
- **Thematic intersection** (Q3): Children and pollution
- **Thematic + geographic** (Q4): Climate adaptation in Brazil
- **Fuzzy topic** (Q5): Micromobility solutions
- **Intervention impact** (Q6): School bus health outcomes
- **Solution-focused** (Q7): Jakarta housing crisis
- **Niche technology** (Q8): Hydrogen
- **Program/corpus** (Q9): World Resources Report papers
- **Temporal + amorphous** (Q10): Urban finance since 2020
- **Amorphous + exclusion** (Q11): Urban finance excluding ebuses

### Pass Criteria
A query passes if **BOTH** conditions are met:
- **Recall ≥ 80%** (find at least 80% of expected documents)
- **Precision ≥ 70%** (at least 70% of retrieved docs are relevant)

### Golden Dataset
- Located: `evaluation/golden-dataset.json`
- 11 queries, 73 total expected documents
- Hand-curated by domain experts
- Each query has expected URLs and metadata

---

## File Structure

```
evaluation/
├── README.md                              # This file
├── ALTERNATIVE_APPROACHES.md              # ⭐ Current strategy
├── PHASE_1_RESULTS.md                     # Historical: Phase 1 attempt results
├── RECALL_IMPROVEMENT_FRAMEWORK.md        # Historical: Original LLM filter design
├── NEXT_STEPS.md                          # Historical: Post-regression analysis
├── golden-dataset.json                    # Test queries and expected results
├── run-cite-eval.ts                       # Full evaluation runner (11 queries)
├── run-cite-eval-quick.ts                 # Quick evaluation runner (3 queries)
├── generate-report.ts                     # Report generator
└── results/
    └── eval-report-{timestamp}.json       # Evaluation results
```

---

## Understanding Results

### Precision
**What it measures:** Of the documents we returned, what % are actually relevant?
- **Formula:** True Positives / (True Positives + False Positives)
- **High precision = few false positives** (user doesn't waste time on irrelevant docs)

### Recall
**What it measures:** Of all relevant documents, what % did we find?
- **Formula:** True Positives / (True Positives + False Negatives)
- **High recall = few false negatives** (user doesn't miss important docs)

### Common Tradeoffs
- **Lower threshold** → More docs → Higher recall, lower precision
- **Stricter filtering** → Fewer docs → Higher precision, lower recall
- **Goal:** Improve both simultaneously by fixing root causes (not just tuning threshold)

---

## Quick Start

### Prerequisites
```bash
# Start Python hybrid service (required)
npm run start:all
# or just: cd hybrid-service && python app.py
```

### 1. Run Evaluation
```bash
npm run eval:cite        # Full (11 queries, ~10 min)
# or
npm run eval:quick       # Quick (3 queries, ~2 min)
```

### 2. Check Results
```bash
# Find latest report
ls -lt evaluation/results/eval-report-*.json | head -1

# View summary
cat evaluation/results/eval-report-{latest}.json | jq '{precision: .overall_precision, recall: .overall_recall, passed: .test_cases_passed}'
```

### 3. Try Quick Improvement
See ALTERNATIVE_APPROACHES.md Option 1 (lower threshold):
- Edit `src/lib/llm-relevance-filter.ts` line 126
- Change `confidenceThreshold: number = 0.6` → `0.35`
- Run `npm run eval:quick` to test

### 4. Explore Next Steps
- Read ALTERNATIVE_APPROACHES.md
- Follow recommended action plan
