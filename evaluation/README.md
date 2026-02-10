## AskWRI Evaluation System

**Current Status:** Speed optimization complete, recall target met, precision needs work.
**Last Updated:** 2026-02-05

## Quick Reference

**Run Cite Mode Evaluations:**
```bash
npm run eval:cite        # Full eval (11 queries, ~8 min)
npm run eval:quick       # Quick eval (3 queries, ~2 min)
npm run eval:report      # Generate report from latest results
```

**Run Answer Mode Evaluations:**
```bash
# Track 1: Retrieval (requires hybrid service)
npm run eval:answer-retrieval

# Track 2: Synthesis (requires Next.js + hybrid service + RAGAS)
pip install -r evaluation/requirements-eval.txt   # first time only
npm run eval:answer-synthesis -- --mode isolated   # golden passages -> synthesis
npm run eval:answer-synthesis -- --mode end-to-end # full pipeline

# Both tracks
npm run eval:answer-full
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
│
├── # Shared infrastructure
├── lib/
│   ├── types.ts                           # Shared type definitions
│   ├── metrics.ts                         # P/R/F1 at set, URL, chunk, doc levels
│   ├── service-client.ts                  # Hybrid service + answer API clients
│   └── ragas_adapter.py                   # Golden set -> RAGAS format converter
│
├── # Cite Mode
├── golden-dataset.json                    # Cite mode: 11 queries, 73 expected docs
├── run-cite-eval.ts                       # Full evaluation runner (11 queries)
├── run-cite-eval-quick.ts                 # Quick evaluation runner (3 queries)
├── generate-report.ts                     # Report generator
│
├── # Answer Mode
├── answer-golden-dataset.json             # Answer mode: golden set (STUB)
├── run-answer-retrieval-eval.ts           # Track 1: passage/doc-level P/R/F1
├── run-answer-synthesis-eval.py           # Track 2: RAGAS faithfulness/relevancy/correctness
├── requirements-eval.txt                  # Python deps for Track 2 (ragas, etc.)
│
├── # Historical
├── ALTERNATIVE_APPROACHES.md
├── PHASE_1_RESULTS.md
├── RECALL_IMPROVEMENT_FRAMEWORK.md
├── NEXT_STEPS.md
│
└── results/
    ├── eval-report-{timestamp}.json       # Cite mode results
    ├── answer-retrieval-{timestamp}.json  # Answer retrieval results
    └── answer-synthesis-{mode}-{ts}.json  # Answer synthesis results
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

---

## Answer Mode Evaluation

Two-track evaluation matching the Answer mode pipeline (retrieval + synthesis).

**Design doc:** `docs/plans/2025-01-28-answer-mode-evaluation-design.md`

### Track 1: Retrieval Eval (TypeScript)

Evaluates whether hybrid retrieval finds the right passages for Answer mode.

- Calls hybrid service with `mode=answer` and ANSWER_PRESET params
- Compares at two granularities: **chunk-level** (with adjacent tolerance) and **doc-level**
- Adjacent tolerance: chunk N+/-1 counts as 0.5 partial match

```bash
npm run eval:answer-retrieval
```

### Track 2: Synthesis Eval (Python + RAGAS)

Evaluates whether the LLM generates good answers given the retrieved passages.

**Setup (first time):**
```bash
pip install -r evaluation/requirements-eval.txt
```

**Two modes:**
- `--mode isolated`: Feed golden passages to answer API (isolates LLM quality)
- `--mode end-to-end`: Actual retrieval -> answer API (full pipeline)

**Metrics:** faithfulness, answer relevancy, answer correctness (via RAGAS) + key facts coverage

```bash
npm run eval:answer-synthesis -- --mode isolated
npm run eval:answer-synthesis -- --mode end-to-end
```

### Golden Dataset Status

The answer mode golden dataset (`answer-golden-dataset.json`) is currently a **stub** with synthetic test cases. Real golden data is being created in parallel. Replace the stub entries with validated Q&A pairs when available.
