## AskWRI Evaluation System

**Last Updated:** 2026-02-23

## Quick Reference

All eval commands are npm scripts. The hybrid service must be running first.

```bash
# Prerequisites: start the hybrid service
npm run hybrid                              # starts Python service on :8002
```

**Cite Mode:**
```bash
npm run eval:cite                           # Full eval (11 queries, ~8 min)
npm run eval:report                         # Generate report from latest results
```

**Answer Mode:**
```bash
npm run eval:answer-retrieval               # Track 1: retrieval P/R/F1

# Track 2: synthesis (requires Next.js + RAGAS)
pip install -r evaluation/requirements-eval.txt   # first time only
npm run eval:answer-synthesis               # defaults to --mode isolated
npm run eval:answer-synthesis -- --mode end-to-end

npm run eval:answer-full                    # runs retrieval then synthesis
```

**Golden Set Management:**
```bash
npm run eval:golden-retrieve                # query hybrid service for chunks
npm run eval:golden-label                   # LLM labels each retrieved chunk
npm run eval:golden-review                  # open label review UI at :3001
npm run eval:golden-assemble                # build final golden dataset from reviewed labels
```

## Prerequisites

| Service | Required for | How to start |
|---------|-------------|-------------|
| Hybrid service (`:8002`) | All evals, golden set generation | `npm run hybrid` |
| Next.js (`:3000`) | Answer synthesis only | `npm run dev` |
| RAGAS Python deps | Answer synthesis only | `pip install -r evaluation/requirements-eval.txt` |

## Cite Mode Evaluation

Tests retrieval recall against a hand-curated golden dataset of 11 queries and 73 expected documents.

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
- **Recall >= 75%**
- **Precision >= 15%**

### Golden Dataset
- Located: `evaluation/golden-dataset.json`
- 11 queries, 73 total expected documents
- Hand-curated by domain experts

---

## Answer Mode Evaluation

Two-track evaluation matching the Answer mode pipeline (retrieval + synthesis).

**Design docs:**
- `docs/plans/2026-02-20-answer-golden-set-generation-design.md` — chunk-first golden set pipeline
- `docs/plans/2026-02-15-answer-retrieval-html-enhancement.md` — HTML report enhancements

### Track 1: Retrieval (`npm run eval:answer-retrieval`)

Evaluates whether hybrid retrieval finds the right passages for Answer mode.

- Calls hybrid service with `mode=answer` and ANSWER_PRESET params
- Compares at two granularities: **chunk-level** (with adjacent tolerance) and **doc-level**
- Adjacent tolerance: chunk N+/-1 counts as 0.5 partial match

### Track 2: Synthesis (`npm run eval:answer-synthesis`)

Evaluates whether the LLM generates good answers given the retrieved passages. Runs via a TS wrapper (`run-answer-synthesis-wrapper.ts`) that spawns the Python eval script.

**Two modes:**
- `--mode isolated` (default): Feed golden passages to answer API (isolates LLM quality)
- `--mode end-to-end`: Actual retrieval -> answer API (full pipeline)

**Metrics:** faithfulness, answer relevancy, answer correctness (via RAGAS) + key facts coverage

### Golden Dataset Generation

The answer golden set is generated via a chunk-first pipeline that queries the live index and uses LLM-assisted labeling with human review.

**Regenerating the golden set** (e.g., after re-chunking the index):

```bash
npm run eval:golden-retrieve    # query hybrid service
npm run eval:golden-label       # LLM labels each chunk
npm run eval:golden-review      # open review UI, validate labels
npm run eval:golden-assemble    # build final golden dataset
```

**Design doc:** `docs/plans/2026-02-20-answer-golden-set-generation-design.md`

### Reviewer Guide

After running `npm run eval:golden-review`, open **http://localhost:3001/eval/review-labels** in your browser.

**What you're looking at:** For each of 9 research questions, an LLM has labeled the top 20 retrieved text passages as Relevant, Partially Relevant, or Not Relevant. Your job is to check these labels and correct any mistakes.

**What the labels mean:**
- **Relevant** — This passage contains information directly useful for answering the question. It would belong in a synthesized answer.
- **Partially Relevant** — From a related document but this specific passage is tangential. It's context, not evidence.
- **Not Relevant** — Not useful for answering the question.

**How labels affect the evaluation:**
- **Relevant** passages are expected at both chunk-level and doc-level (strictest match)
- **Partially Relevant** passages are expected at doc-level only (the right document, not necessarily the right passage)
- **Not Relevant** passages are excluded from expectations entirely

**What to focus on:**
1. Start with questions that show an orange "needs review" badge — these have labels the LLM was uncertain about
2. Expand each question section and review the flagged chunks first
3. Read the passage text and ask: *"Would I include this in a synthesized answer to this question?"*
   - **Yes** → click **Relevant**
   - **It's from the right topic but this passage doesn't directly help** → click **Partial**
   - **No** → click **Not Relevant**
4. High-confidence labels (collapsed section) can be spot-checked but are usually correct

**Tips:**
- Click "Show full text" to see the complete passage — the default view is truncated
- Every click autosaves immediately. You can close the browser and come back later.
- The LLM tends to be conservative — many "Partially Relevant" passages may actually be "Relevant." When in doubt, lean toward Relevant.
- A good answer-mode question should have **3-8 relevant passages** across **2-4 different documents**

**When you're done:** Let the dev team know, then run `npm run eval:golden-assemble` to rebuild the golden set from your reviewed labels.

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
- **Lower threshold** -> More docs -> Higher recall, lower precision
- **Stricter filtering** -> Fewer docs -> Higher precision, lower recall
- **Goal:** Improve both simultaneously by fixing root causes (not just tuning threshold)

---

## Checking Results

```bash
# Find latest cite report
ls -lt evaluation/results/eval-report-*.json | head -1

# View cite summary
cat evaluation/results/eval-report-TIMESTAMP.json | jq '{precision: .overall_precision, recall: .overall_recall, passed: .test_cases_passed}'

# Find latest answer retrieval report
ls -lt evaluation/results/answer-retrieval-*.json | head -1
```

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
├── # Answer Mode — Evaluation
├── answer-golden-dataset.json             # Answer mode: 9 production test cases
├── run-answer-retrieval-eval.ts           # Track 1: passage/doc-level P/R/F1
├── run-answer-synthesis-eval.py           # Track 2: RAGAS faithfulness/relevancy/correctness
├── run-answer-synthesis-wrapper.ts        # TS wrapper for Track 2 Python script
├── generate-answer-report.ts              # HTML report generator for answer evals
├── requirements-eval.txt                  # Python deps for Track 2 (ragas, etc.)
│
├── # Answer Mode — Golden Set Pipeline
├── answer-question-bank.json              # 9 human-written research questions
├── generate-answer-golden-set.ts          # Chunk-first pipeline (retrieve/label/assemble)
├── serve-label-review.ts                  # Label review server with autosave UI (:3001)
├── answer-labels-review.json              # LLM + human-reviewed chunk labels
│
└── results/
    ├── eval-report-{timestamp}.json       # Cite mode results
    ├── answer-retrieval-{timestamp}.json  # Answer retrieval results
    └── answer-synthesis-{mode}-{ts}.json  # Answer synthesis results
```
