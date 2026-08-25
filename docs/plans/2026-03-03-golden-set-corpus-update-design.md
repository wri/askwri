# Golden Set Update for Corpus Change

**Date:** 2026-03-03
**Status:** Approved

## Problem

The document corpus changed (documents added and removed) since the golden sets were created. Both evaluation datasets reference stale identifiers:

- **Cite golden set** (`golden-dataset.json`): 11 queries with 64 expected docs by URL. Some URLs may no longer exist in the corpus.
- **Answer golden set** (`answer-golden-dataset.json`): 9 queries with chunk-level ground truth using `doc_NNNNNN` IDs and `doc_NNNNNN_chunk_NNN` chunk IDs. The corpus now uses descriptive filenames, and re-indexing produced 30,221 chunks (up from 169). All chunk IDs are invalid.

## Approach

Three sequential phases. Each phase gates the next.

### Phase 1: Cite audit and repair

1. Run `verify-golden-docs-simple.ts` to diff expected URLs against `documents.csv`.
2. Remove missing URLs from `expected_urls`; decrement `expected_count`.
3. Flag queries that lose >50% of expected docs for manual review (may no longer be testable).
4. Run `run-cite-eval.ts` for a baseline.

### Phase 2: Answer golden set regeneration

1. Keep the existing 9 questions from `answer-question-bank.json`.
2. Run `generate-answer-golden-set.ts` against the live search service (30K-chunk index on port 8000).
   - Retrieves candidate passages per question.
   - LLM-labels each passage for relevance.
   - Outputs to `answer-labels-review.json`.
3. Human review via `serve-label-review.ts` UI.
4. Run `assemble-synthesis-ground-truth.ts` to write approved labels into `answer-golden-dataset.json`.

New doc_ids will use the current filename-derived format (e.g., `2021_accelerating-innovation-in-urban-service-delivery_1054`) automatically.

### Phase 3: Validation and baseline

1. Run `run-cite-eval.ts` with updated cite golden set.
2. Run `run-answer-retrieval-eval.ts` with regenerated answer golden set.
3. Run `run-answer-synthesis-capture.ts` + `run-answer-synthesis-llm-eval.ts` for synthesis baseline.
4. Commit all updated golden sets and baseline results to `qa` branch.

## What we keep

- All 11 cite questions (unless flagged in Phase 1)
- All 9 answer questions
- Existing eval scripts and pipeline tooling
- Pass criteria thresholds (Recall >= 75%, Precision >= 15%, F1 >= 25%)

## What changes

- `golden-dataset.json`: pruned expected URLs
- `answer-golden-dataset.json`: fully regenerated with new doc_ids, chunk_ids, and passage labels
- `answer-labels-review.json`: regenerated LLM labels
- Baseline eval results in `evaluation/results/`
