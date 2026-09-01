## AskWRI Evaluation System

**Last Updated:** 2026-08-12

## Quick Reference

**Against a deployed instance — no services to run:**
```bash
git submodule update --init                 # once per checkout, fetches the evalsets
npm run eval:qa                             # every evalset vs QA (~1 min)
```
No search service, no database, no AWS credentials. See
[Deployed-instance evals](#deployed-instance-evals) below.

Every other command below runs against a LOCAL search service, which must be
running first:

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
| Search service (`:8000`) | All evals except `eval:qa`, golden set generation | `cd search-service && source venv/bin/activate && uvicorn app.main:app --port 8000` |
| Next.js (`:3000`) | Answer synthesis capture | `npm run dev` (if running on another port, set `NEXTJS_SERVER_URL=http://localhost:<port>`) |
| RAGAS Python deps | Legacy `eval:answer-synthesis` only | `pip install -r evaluation/requirements-eval.txt` |

## Deployed-instance evals

`npm run eval:qa` scores the generation-2 evalsets against a running AskWRI
deployment through its public `/api/llamaindex` gateway. Nothing runs locally
except the script, so there is no corpus to maintain and no credentials to hold.

```bash
git submodule update --init                        # once per checkout
npm run eval:qa                                    # every set in the submodule
EVAL_TARGET=https://other.example npm run eval:qa  # a different instance
npx tsx evaluation/run-evalset.ts <path.json>      # one set
```

Without the submodule checked out there are no fixtures to run, and `eval:qa`
exits telling you to run the `--init` above. A fresh clone of this repo does not
fetch submodule contents; `git clone --recurse-submodules` does it in one step.

**Fixtures** come from the `evaluation/eval-review` submodule, pinned by commit
so a report always traces back to the ground truth that produced it. To take new
sets from upstream:

```bash
git submodule update --remote evaluation/eval-review
git commit evaluation/eval-review -m "chore(eval): bump evalset fixtures"
```

**Reading the output.** These sets key on `external_id`, which is exactly the
`doc_id` the gateway returns, so every case is scored at document grain.
Positive cases report two numbers:

- **MAP (mean average precision)** measures ranking quality: where the expected
  documents sit in the returned list. 100% means every expected doc is at the
  top. Classic set precision is deliberately not reported — the sets label one
  or two documents per query while cite mode returns 13-25, so it would only
  measure list length (unlabeled results are not wrong, just unlabeled).
- **Attainable recall** measures coverage against the expected documents that
  exist in the target's corpus. 100% means retrieval found everything it could
  have. Expected docs missing from the corpus are listed per run as corpus
  gaps — a data request, not a retrieval bug — and a case whose expected docs
  are all missing is reported unscored rather than as a zero.

Negative cases ("Has WRI written about X?" where it hasn't) are scored as
abstentions — did the target correctly return nothing — and reported apart from
the positive means.

**Chunk grain.** Where a case carries `retrieval_ground_truth.expected_passages`
(the answer sets are being migrated to it cluster by cluster upstream), the same
two numbers are also computed over `chunk_id`s — `cAP`/`cR` per case, `Chunk
MAP`/`Chunk recall` for the set — and reported apart from the doc-grain means. A
case without passage ground truth is unscored at this grain, never a zero, and
`cases_chunk_scored` in the report says how much of the set the chunk numbers
cover. Three things to hold when reading them:

- **Chunk recall is capped by list length.** Answer mode returns 15 chunks
  total; a case labelling 12 passages needs almost the whole list to score 100%.
- **A chunk miss can be a document miss.** The passages come from the reviewed
  source document only, so when retrieval returns that document's cross-lingual
  twin instead, chunk recall is 0 by construction. Read `cR` against `aR`.
- **`Chunk recall … allowing an adjacent chunk`** credits a neighbouring chunk
  at half weight. A gap between it and plain chunk recall is chunk-boundary
  drift; a set scoring near zero on both while doc grain stays healthy means the
  fixture's chunk ids no longer match the target's index (re-ingestion), which
  is a fixture refresh, not a retrieval regression.

Retrieval params are deliberately not sent, so the target applies its own
presets and the numbers reflect what users actually get.

## Cite Mode Evaluation

Tests retrieval recall against a hand-curated golden dataset of 11 queries and 74 expected documents.

### Test Queries (11 total)

Queries test different retrieval patterns:
- **Topic area** (Q1): Land value capture (4 docs)
- **Geography** (Q2): Bangalore (6 docs)
- **Thematic intersection** (Q3): Children and pollution (5 docs)
- **Thematic + geographic** (Q4): Climate adaptation in Brazil (4 docs)
- **Fuzzy topic** (Q5): Micromobility solutions (7 docs)
- **Intervention impact** (Q6): School bus health outcomes (6 docs)
- **Solution-focused** (Q7): Jakarta housing crisis (4 docs)
- **Niche technology** (Q8): Hydrogen (3 docs)
- **Program/corpus** (Q9): World Resources Report papers (16 docs)
- **Temporal + amorphous** (Q10): Urban finance since 2020 (6 docs)
- **Amorphous + exclusion** (Q11): Urban finance excluding ebuses (13 docs)

### Pass Criteria

A query passes if **ALL** conditions are met:
- **Recall >= 75%**
- **Precision >= 15%**
- **F1 >= 25%**

### Golden Dataset
- Located: `evaluation/golden-dataset.json`
- 11 queries, 74 total expected documents
- Hand-curated by domain experts, expanded with high-scoring retrievals (score >= 0.8)

---

## Answer Mode Evaluation

Two-track evaluation matching the Answer mode pipeline (retrieval + synthesis).

### Recent: Retrieval Precision Improvements (2026-03-21)

The answer mode pipeline was delivering ~61% precision at synthesis input — meaning ~4 out of 10 passages fed to GPT-5.4 were irrelevant. Broad research queries ("Are denser cities more sustainable?") were worst at 12-25% precision. Two changes were made:

**Phase 1 — Retrieval parameter tuning.** Swept `alpha` (dense/sparse weight) across [0.5, 0.6, 0.65, 0.7]. Setting `alpha=0.65` (favoring semantic search over keyword matching) improved mean P@8 from 61.1% to 63.9%. RerankTopN had no effect — the reranker sees the same candidates regardless of pool size. The broken per-query normalized score threshold (0.75) was removed entirely.

**Phase 2 — GPT-5.4-nano per-chunk relevance filter.** A nano model classifies each passage as strong/partial/weak before synthesis. Only strong and partial passages reach GPT-5.4. The filter also rates overall corpus coverage (good/limited/poor) for UI warnings. Coverage detection correctly flags queries with weak corpus material (e.g., ans_002, ans_007 flagged as "limited").

Overall pipeline: Phase 1 improved retrieval precision from **61.1% → 63.9%**. Phase 2 (nano filter) showed 100% agreement with ground truth labels, but see caveats below.

**Caveats and known limitations:**

1. **Circular evaluation.** The nano filter (GPT-5.4-nano), ground truth labels (GPT-5.4-full), and synthesis evaluator (GPT-5.4) are all from the same model family. GPT-5.4 is both judge and defendant at every layer. The "100% filter precision" figure is expected given this circularity and does not independently validate the filter.

2. **Doc-level aggregation inflates agreement.** Label aggregation uses MAX across chunks per document. Most docs in a 203-doc research corpus have at least one somewhat-relevant chunk for broad queries. The eval encountered zero "weak" docs — meaning it never tested the filter's ability to reject irrelevant material.

3. **Synthesis quality regression.** Before/after synthesis comparison showed consistent regression across all 5 dimensions when the nano filter was active (faithfulness 0.811→0.800, completeness 0.889→0.867, conciseness 0.944→0.911, coherence 0.956→0.911, citation_accuracy 0.811→0.800). The nano filter is currently gated off (`USE_NANO_FILTER=false` by default) pending further investigation.

4. **Alpha field name bug (fixed 2026-03-21).** The `alpha` parameter in `retrieval.ts` was being sent to the Python search service, but Python's `QueryRequest` model uses `dense_weight`/`sparse_weight`. Pydantic silently ignored the unknown field, meaning the Phase 1 alpha=0.65 improvement was never active in production until this fix. The calibration sweep script correctly used `dense_weight`/`sparse_weight`, so sweep results are valid.

5. **What's missing.** An end-to-end synthesis comparison on the worst-performing queries (ans_002 at 25%, ans_006 at 25%) with a different evaluator model family would provide independent validation. Human-validated labels remain the gold standard — all results should be treated as provisional.

**New eval scripts:**
- `evaluation/sweep-answer-retrieval.ts` — alpha × rerankTopN precision sweep
- `evaluation/eval-nano-filter.ts` — nano filter accuracy vs GPT-5.4 debiased labels
- `evaluation/chart-answer-precision.py` — generate comparison charts

**Design docs:**
- `docs/superpowers/specs/2026-03-20-answer-retrieval-precision-design.md` — full design spec
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

**Evaluator model:** Configurable via `SYNTHESIS_EVAL_MODEL` env var (default: `gpt-5.4`). Thinking models (gpt-5*, o1*) are auto-detected for correct API params.

**Design doc:** `docs/plans/2026-02-24-answer-synthesis-eval-design.md`

**Calibration and re-labeling scripts:**
- `evaluation/calibrate-answer-thresholds.ts` — sweeps logit thresholds against LLM labels; established that reranker scores overlap for answer mode (logit floor approach inactive)
- `evaluation/relabel-answer-chunks.ts` — re-labeled all 900 chunks in `answer-labels-review.json` with GPT-5.4 using a debiased methodology (no scores shown in prompt, all 100 chunks included, shuffled order)
- `evaluation/compare-synthesis-evals.ts` — compares before/after synthesis eval results (to be created)

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
