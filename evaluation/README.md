## AskWRI Evaluation System

**Last Updated:** 2026-02-27

## Quick Reference

All eval commands are npm scripts. The hybrid service must be running first.

```bash
# Prerequisites: start the search service
cd search-service && source venv/bin/activate
uvicorn app.main:app --port 8000            # starts Python service on :8000
```

**Cite Mode:**
```bash
npm run eval:cite                           # Full eval (11 queries, ~8 min)
npm run eval:report                         # Generate HTML report from latest results
```

**Answer Mode:**
```bash
npm run eval:answer-retrieval               # Track 1: retrieval P/R/F1
npm run eval:answer-report                  # Generate HTML report for answer evals

# Legacy RAGAS-based synthesis eval (requires Python deps)
pip install -r evaluation/requirements-eval.txt   # first time only
npm run eval:answer-synthesis               # defaults to --mode isolated

npm run eval:answer-full                    # runs retrieval then legacy synthesis
```

**Golden Set Management:**
```bash
npm run eval:golden-retrieve                # query hybrid service for chunks
npm run eval:golden-label                   # LLM labels each retrieved chunk
npm run eval:golden-review                  # open review UI at :3001
npm run eval:golden-assemble                # build final golden dataset from reviewed labels
```

**Synthesis Evaluation (Track 2 — Human-in-the-loop):**
```bash
npm run eval:synthesis-capture              # Stage 1: capture system outputs (needs hybrid + Next.js)
npm run eval:synthesis-llm-eval             # Stage 2: LLM scoring (needs OPENAI_API_KEY)
npm run eval:synthesis-prepare-review       # Merge into review format
npm run eval:golden-review                  # Stage 3: open review UI at :3001/eval/review-synthesis
npm run eval:synthesis-assemble             # Stage 4: write ground truth to golden dataset
```

**S3 Sync (QA Reviewer Workflow):**
```bash
npm run eval:upload                # push eval data to S3 for QA reviewers
npm run eval:download              # pull reviewed data from S3
```

## Prerequisites

| Service | Required for | How to start |
|---------|-------------|-------------|
| Search service (`:8000`) | All evals, golden set generation | `cd search-service && source venv/bin/activate && uvicorn app.main:app --port 8000` |
| Next.js (`:3000`) | Answer synthesis capture | `npm run dev` |
| RAGAS Python deps | Legacy `eval:answer-synthesis` only | `pip install -r evaluation/requirements-eval.txt` |

## Cite Mode Evaluation

Tests retrieval recall against a hand-curated golden dataset of 11 queries and 64 expected documents.

### Test Queries (11 total)

Queries test different retrieval patterns:
- **Topic area** (Q1): Land value capture (4 docs)
- **Geography** (Q2): Bangalore (6 docs)
- **Thematic intersection** (Q3): Children and pollution (3 docs)
- **Thematic + geographic** (Q4): Climate adaptation in Brazil (3 docs)
- **Fuzzy topic** (Q5): Micromobility solutions (7 docs)
- **Intervention impact** (Q6): School bus health outcomes (4 docs)
- **Solution-focused** (Q7): Jakarta housing crisis (4 docs)
- **Niche technology** (Q8): Hydrogen (4 docs)
- **Program/corpus** (Q9): World Resources Report papers (16 docs)
- **Temporal + amorphous** (Q10): Urban finance since 2020 (4 docs)
- **Amorphous + exclusion** (Q11): Urban finance excluding ebuses (9 docs)

### Pass Criteria

A query passes if **ALL** conditions are met:
- **Recall >= 75%**
- **Precision >= 15%**
- **F1 >= 25%**

### Golden Dataset
- Located: `evaluation/golden-dataset.json`
- 11 queries, 64 total expected documents
- Hand-curated by domain experts

---

## Answer Mode Evaluation

Two-track evaluation matching the Answer mode pipeline (retrieval + synthesis).

**Design docs:**
- `docs/plans/2026-02-20-answer-golden-set-generation-design.md` — chunk-first golden set pipeline
- `docs/plans/2026-02-15-answer-retrieval-html-enhancement.md` — HTML report enhancements

### Track 1: Retrieval (`npm run eval:answer-retrieval`)

Evaluates whether hybrid retrieval finds the right passages for Answer mode.

- Calls hybrid service with `mode=answer` using params from `ANSWER_PRESET` (in `src/config/retrieval`)
- Compares at two granularities: **chunk-level** (with adjacent tolerance) and **doc-level**
- Adjacent tolerance: chunk N+/-1 counts as a partial match

### Track 2: Synthesis (Human-in-the-loop)

Evaluates whether the LLM generates good answers given retrieved passages. Uses a 4-stage pipeline with LLM pre-evaluation and human review.

**Stages:**
1. `npm run eval:synthesis-capture` — Run end-to-end system, capture passages + synthesis for each test case
2. `npm run eval:synthesis-llm-eval` — External LLM scores each synthesis on 5 dimensions (0-1)
3. `npm run eval:golden-review` — Human reviewer adjusts scores via web UI at `:3001/eval/review-synthesis`
4. `npm run eval:synthesis-assemble` — Write qualifying answers to golden dataset

**Scoring dimensions:** faithfulness, completeness, conciseness, coherence, citation_accuracy

**Evaluator model:** Configurable via `SYNTHESIS_EVAL_MODEL` env var (default: `gpt-4o`). Thinking models (gpt-5*, o1*) are auto-detected for correct API params.

**Design doc:** `docs/plans/2026-02-24-answer-synthesis-eval-design.md`

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

**What you're looking at:** For each of 9 research questions, an LLM has labeled the top 30 retrieved text passages as Relevant, Partially Relevant, or Not Relevant. Your job is to check these labels and correct any mistakes.

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
- A good answer-mode question typically has **15-30 relevant passages** across **1-8 different documents**

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

## QA Reviewer Access

External reviewers access the evaluation UIs via the QA server — no local setup required.

**Review URLs (QA):**
- Label review: `http://<qa-alb>/api/eval/review-labels`
- Synthesis review: `http://<qa-alb>/api/eval/review-synthesis`
- Cite report: `http://<qa-alb>/api/eval/review-cite`

**Local dev review server** (`npm run eval:golden-review` on `:3001`):
- Label review: `http://localhost:3001/eval/review-labels`
- Synthesis review: `http://localhost:3001/eval/review-synthesis`

Note: The local dev server does not serve cite reports — use the QA server or view JSON directly.

**Developer workflow:**
```bash
# 1. Run evals locally
npm run eval:cite
npm run eval:answer-retrieval
npm run eval:synthesis-capture
npm run eval:synthesis-llm-eval
npm run eval:synthesis-prepare-review

# 2. Upload data to S3 for reviewers (needs DOCUMENTS_S3_BUCKET and AWS creds in .env)
npm run eval:upload

# 3. After reviewer completes their work, pull data back
npm run eval:download

# 4. Continue with assembly
npm run eval:golden-assemble
npm run eval:synthesis-assemble
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
├── golden-dataset.json                    # Cite mode: 11 queries, 64 expected docs
├── run-cite-eval.ts                       # Full evaluation runner (11 queries)
├── generate-report.ts                     # HTML report generator for cite results
│
├── # Answer Mode — Evaluation
├── answer-golden-dataset.json             # Answer mode: 9 test cases with synthesis ground truth
├── run-answer-retrieval-eval.ts           # Track 1: passage/doc-level P/R/F1
├── run-answer-synthesis-capture.ts        # Track 2 Stage 1: capture system outputs
├── run-answer-synthesis-llm-eval.ts       # Track 2 Stage 2: LLM scoring (5 dimensions)
├── prepare-synthesis-review.ts            # Track 2: merge capture + LLM eval for review
├── assemble-synthesis-ground-truth.ts     # Track 2 Stage 4: write to golden dataset
├── generate-answer-report.ts              # HTML report generator for answer evals
├── run-answer-synthesis-eval.py           # Legacy: RAGAS-based synthesis eval
├── run-answer-synthesis-wrapper.ts        # Legacy: TS wrapper for RAGAS eval
├── requirements-eval.txt                  # Python deps for legacy RAGAS eval
│
├── # Answer Mode — Golden Set Pipeline
├── answer-question-bank.json              # 9 human-written research questions
├── generate-answer-golden-set.ts          # Chunk-first pipeline (retrieve/label/assemble)
├── serve-label-review.ts                  # Label + synthesis review server (:3001, local dev)
├── answer-labels-review.json              # LLM + human-reviewed chunk labels
├── answer-retrieval-raw.json              # Raw retrieval results from golden set generation
├── answer-synthesis-raw.json              # Stage 1 output: captured passages + synthesis
├── answer-synthesis-llm-eval.json         # Stage 2 output: LLM scores per test case
├── answer-synthesis-eval-final.json       # Stage 3 output: merged review-ready data
├── upload-eval-to-s3.ts                   # Push eval data to S3 for QA reviewers
├── download-eval-from-s3.ts              # Pull reviewed data from S3
│
├── # Diagnostics (ad-hoc debugging tools)
├── analyze-missing-docs.ts               # Analyze docs missing from retrieval
├── check-golden-urls.ts                   # Validate golden dataset URLs
├── cite-recall-diagnostic.ts              # Detailed cite recall analysis
├── debug-retrieval.ts                     # Debug individual retrieval queries
├── diagnose-pre-filter-recall.ts          # Pre-filter stage recall analysis
├── diagnose-retrieval-gaps.ts             # Identify retrieval gap patterns
├── document-analysis.ts                   # Analyze document-level statistics
├── map-passages-to-chunks.ts              # Map passage text to chunk IDs
├── run-cite-eval-no-filter.ts             # Cite eval with filters disabled
├── test-rerank-topn.ts                    # Test reranker top-N settings
├── verify-golden-docs.ts                  # Verify golden docs exist in index
├── verify-golden-docs-simple.ts           # Simplified golden doc verification
├── diagnostics/
│   └── diagnostic-runner.ts               # Generic diagnostic runner
│
├── # Legacy / superseded
├── golden-dataset-updated.json            # Older version of cite golden dataset
│
└── results/                               # All eval output (gitignored)
    ├── eval-report-{timestamp}.json       # Cite mode results
    ├── eval-report-{timestamp}.html       # Cite mode HTML reports
    ├── answer-retrieval-{timestamp}.json  # Answer retrieval results
    ├── answer-retrieval-{timestamp}.html  # Answer retrieval HTML reports
    ├── diagnostic-{timestamp}.json        # Diagnostic output
    └── pre-filter-diagnostic-*.json       # Pre-filter diagnostic output
```

### Next.js Eval Routes (QA Server)

```
src/
├── lib/
│   ├── eval-storage.ts                    # S3/local eval file storage abstraction
│   └── eval-html-templates.ts             # HTML templates for review UIs
└── app/api/eval/
    ├── labels/route.ts                    # GET labels JSON
    ├── labels/override/route.ts           # POST label override
    ├── review-labels/route.ts             # GET label review HTML page
    ├── synthesis-eval/route.ts            # GET synthesis eval JSON
    ├── synthesis-eval/review/route.ts     # POST human eval update
    ├── synthesis-raw/route.ts             # GET captured passages JSON
    ├── review-synthesis/route.ts          # GET synthesis review HTML page
    ├── cite-report/route.ts              # GET cite report JSON
    └── review-cite/route.ts              # GET cite report HTML page
```
