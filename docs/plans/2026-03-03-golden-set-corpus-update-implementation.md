# Golden Set Corpus Update — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update both golden evaluation datasets to match the current 169-document corpus with new filenames and 30K chunks.

**Architecture:** Three-phase sequential pipeline: (1) audit cite golden set URLs against current catalog, (2) regenerate answer golden set via existing LLM-labeling pipeline, (3) run all evals for baseline metrics.

**Tech Stack:** TypeScript (tsx), Node.js, Python search service (FastAPI/LlamaIndex), OpenAI API

---

### Task 1: Create feature branch

**Files:** None

**Step 1: Create and switch to feature branch**

```bash
git checkout -b feat/golden-set-corpus-update qa
```

**Step 2: Verify branch**

```bash
git branch --show-current
```
Expected: `feat/golden-set-corpus-update`

---

### Task 2: Fix data path in verify scripts

The verify scripts reference `../data/documents.csv` (resolves to repo root `data/`) but the CSV lives at `search-service/data/documents.csv`.

**Files:**
- Modify: `evaluation/verify-golden-docs-simple.ts:14`
- Modify: `evaluation/verify-golden-docs.ts:14` (if same issue)
- Modify: `evaluation/check-golden-urls.ts:11`

**Step 1: Update path in verify-golden-docs-simple.ts**

Change line 14 from:
```typescript
const catalogPath = path.join(__dirname, '../data/documents.csv');
```
to:
```typescript
const catalogPath = path.join(__dirname, '../search-service/data/documents.csv');
```

**Step 2: Apply same fix to verify-golden-docs.ts and check-golden-urls.ts**

Same pattern — change `../data/documents.csv` to `../search-service/data/documents.csv`.

**Step 3: Run verify to confirm path works**

```bash
npx tsx evaluation/verify-golden-docs-simple.ts
```
Expected: Script runs, prints URL counts (may show missing docs — that's expected).

**Step 4: Commit**

```bash
git add evaluation/verify-golden-docs-simple.ts evaluation/verify-golden-docs.ts evaluation/check-golden-urls.ts
git commit -m "fix(eval): update data path to search-service/data in verify scripts"
```

---

### Task 3: Audit cite golden set

**Files:**
- Modify: `evaluation/golden-dataset.json`

**Step 1: Run verify script to identify missing URLs**

```bash
npx tsx evaluation/verify-golden-docs-simple.ts
```
Expected: A list of missing URLs by test case and a summary count.

**Step 2: Record which URLs are missing**

Save the output. Note any test cases that lose >50% of expected docs.

**Step 3: Edit golden-dataset.json — remove missing URLs**

For each test case, remove URLs not found in the catalog from `expected_urls` and update `expected_count` to match the new array length.

**Step 4: Re-run verify to confirm clean**

```bash
npx tsx evaluation/verify-golden-docs-simple.ts
```
Expected: `All expected documents exist in the catalog!` (exit 0).

**Step 5: Commit**

```bash
git add evaluation/golden-dataset.json
git commit -m "fix(eval): prune cite golden set for current corpus"
```

---

### Task 4: Run cite eval for baseline

**Prereq:** Search service running on port 8000 with indexed corpus.

**Files:**
- Output: `evaluation/results/eval-report-*.json`
- Output: `evaluation/results/eval-report-*.html`

**Step 1: Run cite evaluation**

```bash
npm run eval:cite
```
Expected: Runs 11 queries, prints P/R/F1 per query and aggregate. Writes JSON + HTML report to `evaluation/results/`.

**Step 2: Review results**

Check aggregate metrics. Note any queries with recall < 50% — these may need question review.

**Step 3: Generate HTML report**

```bash
npm run eval:report
```

**Step 4: Commit baseline**

```bash
git add evaluation/results/
git commit -m "eval: cite mode baseline with updated corpus"
```

---

### Task 5: Regenerate answer golden set — retrieve phase

**Prereq:** Search service running on port 8000.

**Files:**
- Output: `evaluation/answer-labels-review.json` (or similar)

**Step 1: Run retrieval phase**

```bash
npm run eval:golden-retrieve
```
Expected: Queries each of the 9 answer questions against the live index, retrieves candidate chunks. Outputs raw retrieval data.

**Step 2: Verify output exists**

Check that the retrieval output file was created and contains results for all 9 questions.

**Step 3: Commit retrieval data**

```bash
git add evaluation/
git commit -m "eval: answer golden set retrieve phase with new corpus"
```

---

### Task 6: Regenerate answer golden set — label phase

**Files:**
- Output: `evaluation/answer-labels-review.json`

**Step 1: Run LLM labeling phase**

```bash
npm run eval:golden-label
```
Expected: LLM labels each retrieved passage as relevant/not-relevant. Uses OpenAI API. May take several minutes.

**Step 2: Verify labels output**

Check that label file exists and contains labels for all 9 questions with passage-level judgments.

**Step 3: Commit labels**

```bash
git add evaluation/
git commit -m "eval: answer golden set label phase complete"
```

---

### Task 7: Human review of labels

**Files:**
- Modified by reviewer: `evaluation/answer-labels-review.json`

**Step 1: Start review server**

```bash
npm run eval:golden-review
```
Expected: Starts review UI on port 3001 (or another port). Opens browser to review/correct LLM labels.

**Step 2: Review labels in browser**

Human reviewer checks LLM relevance judgments, corrects any errors. This is a manual step.

**Step 3: Stop review server when done**

Ctrl+C the server.

**Step 4: Commit reviewed labels**

```bash
git add evaluation/
git commit -m "eval: human-reviewed answer labels"
```

---

### Task 8: Assemble answer golden dataset

**Files:**
- Output: `evaluation/answer-golden-dataset.json`

**Step 1: Run assemble phase**

```bash
npm run eval:golden-assemble
```
Expected: Writes approved labels into `answer-golden-dataset.json` with new doc_ids (filename-derived) and chunk_ids.

**Step 2: Verify golden dataset**

Check that `answer-golden-dataset.json` has all 9 test cases with updated doc_ids and chunk_ids matching the current corpus format.

**Step 3: Commit**

```bash
git add evaluation/answer-golden-dataset.json
git commit -m "eval: regenerated answer golden dataset for current corpus"
```

---

### Task 9: Run answer retrieval eval for baseline

**Prereq:** Search service running.

**Files:**
- Output: `evaluation/results/answer-retrieval-*.json`
- Output: `evaluation/results/answer-retrieval-*.html`

**Step 1: Run answer retrieval eval**

```bash
npm run eval:answer-retrieval
```
Expected: Runs 9 queries, computes chunk-level and doc-level P/R/F1.

**Step 2: Generate HTML report**

```bash
npm run eval:answer-report
```

**Step 3: Commit baseline**

```bash
git add evaluation/results/
git commit -m "eval: answer retrieval baseline with updated corpus"
```

---

### Task 10: Run synthesis eval for baseline

**Files:**
- Output: `evaluation/answer-synthesis-raw.json`
- Output: `evaluation/answer-synthesis-llm-eval.json`

**Step 1: Capture synthesis outputs**

```bash
npm run eval:synthesis-capture
```
Expected: Queries the answer API for each test case, captures passages + synthesized answers.

**Step 2: Run LLM synthesis evaluation**

```bash
npm run eval:synthesis-llm-eval
```
Expected: Scores each synthesis on 5 dimensions (faithfulness, completeness, conciseness, coherence, citation_accuracy).

**Step 3: Commit synthesis baseline**

```bash
git add evaluation/
git commit -m "eval: synthesis baseline with updated corpus"
```

---

### Task 11: Final commit and summary

**Step 1: Review all changes on branch**

```bash
git log --oneline qa..HEAD
```

**Step 2: Summarize results**

Compare cite and answer baselines. Note any queries that need attention (low recall, degraded synthesis quality).

**Step 3: Push branch**

```bash
git push -u origin feat/golden-set-corpus-update
```
