# AskWRI Evaluation System

**Last Updated:** 2026-09

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
npm run eval:upload-cite                    # Publish the latest report for QA reviewers (/api/eval/review-cite)
```

**Answer Mode (gen-2 harness):**
```bash
npm run eval:answer-capture -- <evalset.json>
npm run eval:answer-judge   -- --capture evaluation/answer/artifacts/capture-<label>.json
npm run eval:answer-score   -- --capture ... --judged ...
npm run eval:answer-compare -- <reportA.json> <reportB.json>
```
See [Answer Mode Evaluation](#answer-mode-evaluation) below. The gen-1 answer
eval scripts, golden set, and review UIs were deleted (spec §3 of the
answer-eval overhaul); git history has them.

## Prerequisites

| Service | Required for | How to start |
|---------|-------------|-------------|
| Search service (`:8000`) | All evals except `eval:qa` | `cd search-service && source venv/bin/activate && uvicorn app.main:app --port 8000` |

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

The gen-2 answer eval lives in `evaluation/answer/`. It replaces the gen-1
machinery (retrieval P/R/F1 against a self-labeled golden set, the
human-in-the-loop synthesis pipeline, and the review UIs), which was deleted.

### Stages and artifacts

```
capture  →  evaluation/answer/artifacts/capture-<label>.json   (API calls: retrieval + synthesis)
judge    →  evaluation/answer/artifacts/judged-<label>.json    (API calls: judge only; resumable)
score    →  evaluation/answer/artifacts/report-<label>.json    (no API calls; pure)
compare  →  stdout                           (two reports, same fixture + passes)
```

```bash
npm run eval:answer-capture -- <evalset.json> [--passes N --knob k=v ...]
npm run eval:answer-judge   -- --capture evaluation/answer/artifacts/capture-<label>.json
npm run eval:answer-score   -- --capture evaluation/answer/artifacts/capture-<label>.json --judged evaluation/answer/artifacts/judged-<label>.json
npm run eval:answer-compare -- <reportA.json> <reportB.json>
```

Every artifact carries a provenance block: fixture commit (submodule SHA),
target URL or local config snapshot, every injected knob, synthesis and judge
models with base URLs, prompt hashes, pass count, and timestamp. Judge verdicts
are keyed `(case, pass, item)` and carry the prompt hash and judge model.

Run every stage CLI from the repo root (the npm scripts do): `tsx` resolves
the `@/` alias from the cwd's `tsconfig.json`, so from another directory the
route imports silently load a different tree.

- **capture** records, per case per pass: retrieved chunk list with scores,
  `chunk_id`, `doc_id`, `likely_off_topic`; `passages_sent`; the route's
  debug block (`raw_model_json`); parsed sentences with cites; latency; cost
  from usage fields. The artifact is checkpointed after every case. Preflight
  aborts before any paid call when a doc or snippet is missing or the
  synthesis probe (which carries the run's `model`/`base_url` knobs) falls
  back; drop a blocking case with `--skip`. A pass whose route reply was an
  infrastructure fallback (`no_api_key`, `api_error`, `exception`) is recorded
  as an answer error and never judged or scored.
- **judge** reads a capture and writes verdicts. A partial `judged-*.json` is
  resumed; only missing items run (an `unjudged` item from an aborted run is
  retried, and so is any item judged by another model or prompt version).
  The judged file is fingerprinted to its capture — re-capturing under the
  same label and re-judging is refused rather than silently reusing stale
  verdicts. Progress is written after every item, so Ctrl-C or a 401 abort
  preserves it. Exits 1 when every attempted item came back unjudged (a
  misconfigured judge, e.g. a 4xx on every call).
- **score** is a pure function `(fixture, capture, judged) → report` — no API
  calls, byte-identical on re-run. `unjudged` items and retrieval/answer
  errors are excluded from means and counted separately, never scored as
  zero; the unsupported-claims count is always shown with the number of
  judged passes it covers.
- **compare** refuses runs with different fixture commits, pass counts, case
  sets, or target modes (gateway vs direct chunk text differ), and prints
  headline/draft block deltas followed by per-case deltas.

### Controls

Only `run-capture` uses the full flag set: `--only <case-id>` / `--skip
<case-id>` (repeatable), `--limit N`, `--passes N` (default 1), `--label`
(default: evalset basename sans `.json`), `--concurrency` (default 1),
`--target URL` (default `EVAL_TARGET` or `https://qa.askwri-app.org`),
`--timeout MS` (per `/api/answer` call; default 300000 — lunaroute-hosted
synthesis is slow), `--knob key=value` (repeatable), `--direct-search URL` /
`--direct-answer URL` (switch to local services instead of the deployed
gateway). The other stage CLIs each have their own parser:
- `run-judge` — `--capture`, `--label`, `--judge-model`, `--judge-base-url`,
  `--only`, `--concurrency`
- `run-score` — `--capture`, `--judged`, `--label`, `--labels` (see
  [Judge calibration against human labels](#judge-calibration-against-human-labels) below)
- `run-compare` — two positional paths plus `--judged`/`--pairwise` mode,
  `--label-a`/`--label-b`, `--judge-model`, `--judge-base-url`

### Judge-only runs are composition, not a flag

There is no `--judge-only` mode. Judging a stored capture at zero synthesis cost
is just `run-judge --capture <file>`, and agreement between two judge models is
`run-compare --judged <judgedA.json> <judgedB.json>`. For A/B synthesis
comparison there is also `run-compare --pairwise <captureA.json> <captureB.json>`
(judge sees both answers in randomized order; reported as win rate with the
order-swap check).

### Judge calibration against human labels

`run-score --labels <path>` (repeatable; each path is a label file or a
directory, from which only `labels-*.json` files are read — the evalset-review
notebook's `annot-*.json` files share the same `review-output/` folder)
attaches human review labels to the score report. Labels are produced by the
eval-review repo's system-output notebook: a reviewer works through a stored
capture and saves one `labels-<capture>-<case>-pass<N>-by-<reviewer>.json`
file per case, pass, and reviewer (schema `answer-eval/human-labels@1`).
Every label is validated against the capture — its recorded checksum must
match, and every fact and sentence index must exist in that case and pass —
so a label made from a different capture run is refused (exit 2, listing
every rejection with its reason) rather than silently mixed into the report.
The checksum is a sha256 over the capture's `cases`; the capture stage writes
it into the artifact as `capture_fingerprint` so the notebook copies it
rather than re-hashing (Python and Node format small floats differently, so
a re-hash is not portable).

With labels, the report header changes: `judge: uncalibrated` becomes a
calibration object (`calibrated`, label count, reviewers) and a
`judge_agreement` block is added, while the console prints judge-vs-human
agreement per verdict type — fact stated/partial/absent, sentence
supported/unsupported, and the unsupported-claims count. The agreement
measure mirrors the two-judge agreement mode: for each verdict type it is
counted only where both the judge and the human produced a verdict
(symmetric either-denominator); labeled items with no judged counterpart are
counted as excluded, never scored. One carve-out: a sentence with no
resolvable citation produces no judged `sentence_support` item at all (the
judge covers it only through `unsupported_claims`), so a human verdict on
such a sentence is never counted excluded — it joins only through the
unsupported-claims tally. Reviewers are independent — all of them
for the same case+pass join, each compared against the same judged verdicts —
and the same reviewer's later file for the same case+pass wins (a corrected
file supersedes their earlier one).

Without `--labels` nothing changes: the report is byte-identical to a plain
run. The fixture data enabling this (answer twins, negative cases,
`review_status` fields) arrives with the eval-review submodule pin bump,
separately.

### Cost caveats

Capture sums the gateway's `usage.total_usd` (the answer route reports no
usage). Judge cost is tracked in provider token counts, **not dollars** —
lunaroute pricing per token is unmeasured, so tokens are recorded and never
converted. The judged artifact persists the accumulated totals (`usage`:
prompt/completion tokens + judge call count), and the report header carries
them as `cost.judge`; budget estimates still lack judge dollars.

---

## Understanding Results

### Precision
**What it measures:** Of the documents we returned, what % are actually relevant?
- **Formula:** True Positives / (True Positives + False Positives)
- **High precision = few false positives** (user doesn't waste time on irrelevant docs)

### Recall
**What it measures:** Of all relevant documents, what % did we find?
- **Formula:** True Positives / (True Positives + False Negatives)
- **High recall = few false negatives** (user doesn't miss relevant docs)

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

# Answer-eval artifacts (gen-2 harness)
ls -lt evaluation/answer/artifacts/
```

---

## QA Reviewer Access

External reviewers access the cite report via the QA server — no local setup
required. Publish it with `npm run eval:upload-cite` after `eval:cite`
(needs `DOCUMENTS_S3_BUCKET` and AWS creds in `.env`).

**Review URLs (QA):**
- Cite report: `http://<qa-alb>/api/eval/review-cite`

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
│   └── service-client.ts                  # Hybrid service + answer API clients
│
├── # Cite Mode
├── golden-dataset.json                    # Cite mode: 11 queries, 64 expected docs
├── run-cite-eval.ts                       # Full evaluation runner (11 queries)
├── generate-report.ts                      # HTML report generator for cite results
├── upload-cite-report.ts                   # Publish latest cite report to S3 for QA reviewers
│
├── # Answer Mode — gen-2 harness
├── answer/
│   ├── run-capture.ts                     # Stage CLI: capture
│   ├── run-judge.ts                       # Stage CLI: judge (resumable)
│   ├── run-score.ts                       # Stage CLI: score (pure)
│   ├── run-compare.ts                      # Stage CLI: compare / agreement / pairwise
│   ├── cli.ts                             # Shared control parsing
│   ├── capture.ts / judge.ts / score.ts / compare.ts   # Stage cores
│   ├── fixture.ts / normalize.ts / http.ts / target.ts / preflight.ts
│   ├── judge-client.ts / judge-prompts.ts / types.ts / test-server.ts
│   ├── __tests__/                          # Harness tests
│   └── artifacts/                          # Stage outputs (gitignored)
│
├── # Diagnostics (ad-hoc debugging tools)
├── analyze-missing-docs.ts               # Analyze docs missing from retrieval
├── check-golden-urls.ts                  # Validate golden dataset URLs
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
└── results/                               # All eval output (gitignored)
    ├── eval-report-{timestamp}.json       # Cite mode results
    ├── eval-report-{timestamp}.html       # Cite mode HTML reports
    ├── diagnostic-{timestamp}.json        # Diagnostic output
    └── pre-filter-diagnostic-*.json       # Pre-filter diagnostic output
```

### Next.js Eval Routes (QA Server)

```
src/
├── lib/
│   ├── eval-storage.ts                    # S3/local eval file storage abstraction
│   └── eval-html-templates.ts             # HTML template for the cite report UI
└── app/api/eval/
    ├── cite-report/route.ts               # GET cite report JSON
    └── review-cite/route.ts               # GET cite report HTML page
```
