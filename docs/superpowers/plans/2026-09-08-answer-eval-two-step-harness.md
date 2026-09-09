# Answer-eval two-step flow — harness implementation (PR 1)

**Date:** 2026-09-08
**Spec:** `docs/superpowers/specs/2026-09-08-answer-eval-two-step-flow-design.md` (rev 3)
**Scope:** §5–§9 of the spec — harness changes only, app repo. The evalset
restructure (§3) is the eval-review repo's parallel workstream (doc sets are
authored there). Baselines and sweeps are out of scope. The mode-2 notebook
one-liner rides with the evalset PR, not this one.

## Worktree

- `.claude/worktrees/answer-eval-twostep`, branch
  `worktree-answer-eval-twostep`, based on `docs/answer-eval-two-step-spec`
  (stacked on PR #399 — rebase after it merges).
- Never `cd` the main checkout (it is on the user's branch with uncommitted
  work). Run `npm ci` in the worktree before the first gate run.

## Constraints (program standing rules)

- No live model/service calls from tests — local fake `http.Server`s only;
  Jest harness files start with `/** @jest-environment node */`; fake-server
  tests call `closeAllConnections()` before `close()`.
- Nothing new runs in CI.
- Read a file before editing it; targeted edits, not rewrites; nothing
  beyond this plan.
- No Co-Authored-By trailers in commits.
- Gates (from the worktree root): `npm test`, `npm run lint`,
  `npm run format:check`, `npx tsc --project tsconfig.json --noEmit`
  (gate = zero NEW errors; `evaluation/` is excluded from tsconfig, so
  harness code must stay jest- and lint-clean).

## Pre-made rulings

1. **Schema:** captures write `answer-eval/capture@2`. `run-judge` and
   `run-score` **read both @1 and @2** (the 2026-09-08 smoke artifacts stay
   valid). The notebook's acceptance widens on the eval-review side.
2. **`--selection-mode`** (`fixture-set` | `no-selection`), default
   `fixture-set`. An evalset without `doc_sets` is a hard error in
   `fixture-set` mode (message pointing at the evalset PR) and is **allowed**
   in `no-selection` mode — the selection derives from the cite query, doc
   sets unused. This means the current evalset can run `no-selection` the
   moment this PR lands.
3. **Selection is derived once per run** (pass 0 semantics) and reused
   across passes; pass spreads measure synthesis variance only.
4. **Fingerprint:** sha over `cases` when the selection block is absent —
   byte-identical to @1, so the committed pin
   (`__tests__/fixtures/capture-fingerprint-pin.json` + `PIN_HEX`) and all
   @1 judged-resume/label binding stay untouched — and sha over `cases`
   **plus** the selection block when present. A re-capture under the same
   label with a different mode or doc set therefore refuses stale judge
   verdicts/labels; @1 captures keep their historical fingerprints. Never
   re-pin PIN_HEX.
5. **Zero-doc cite result** → outcome `unreachable`: no answer call, no
   error, represented in the @2 artifact as an explicit per-pass
   `unreachable: true` marker. Negative case → counts as abstention (pass);
   positive case → cite-stage failure, synthesis lanes excluded, counted in
   a new `unreachable` header bucket. `judge.ts`'s job enumeration skips
   such passes (same exclusion class as answer errors), and `score.ts` keys
   the bucket on the marker. A cite-call **transport failure** in
   no-selection mode is a per-case retrieval error (all passes excluded),
   never `unreachable`.
6. **Rank-gap diagnostic, not gate:** preflight's existence check uses a
   snippet-derived query — **the first 48 code points of the trimmed
   `text_snippet`** (deterministic; no language detection — wide-pool,
   doc-scoped lookups make rank irrelevant, only determinism matters; never
   the case question). The question-based lookup still runs and its misses
   are recorded per case as `rank_gaps` in the preflight report AND lifted
   into the score report header (per-case count) beside the `unreachable`
   bucket — informative, never fatal.
7. **validDocs mirror:** before `/api/answer`, apply the UI's exact
   predicate (`AIResearchModal.tsx:138–147`): keep a doc iff
   `kps.length > 0 && kps.some(kp => kp.snippet?.length > 10)`.

## Tasks

**Task 1 — fixture contract** (`evaluation/answer/fixture.ts`, `types.ts`)
- `Evalset` gains `doc_sets: Array<{ id, doc_ids, note? }>`; test cases gain
  optional `doc_set_id`. Helper `docSetOf(evalset, case)`. Validation: a
  `doc_set_id` that names no set is a load error; negative cases carry one
  too (checked at capture, not load — the evalset PR may still be in flight).
  fixture-set capture **hard-errors** on any selected case lacking a
  resolvable doc set. Cheap capture-time check: every expected doc (+ twin)
  is ⊆ the case's doc set (q16's union must hold).
- Tests: synthetic evalset JSON (doc sets, missing-set error, case without
  `doc_set_id` in no-selection-tolerant path, subset violation).

**Task 2 — cite queries** (`evaluation/answer/target.ts`)
- Gateway: `cite(query)` → `POST /api/llamaindex` with the UI client's full
  body (`llamaindex-client.ts:49–57`):
  `{ query, mode: 'cite', max_results: 40, similarity_threshold: 0.0,
  include_metadata: true, rerank: true }`. (The route hardcodes the same
  values, so behavior is identical — but send the full shape for fidelity.)
  Returns ranked doc ids.
- Direct: `CITE_MODE_QUERY_DEFAULTS` mirrors the route's cite-mode request
  **field-for-field**: `max_results: 40, vector_top_k: 500, bm25_top_k: 500,
  rerank_top_n: 500, fusion_top_k: 500, similarity_threshold: 0.0,
  include_metadata: true, rerank: true` — and **no dense/sparse weights**
  (the gateway sets none for cite mode; do not invent
  them).
- Tests: fake servers assert the request bodies byte-exactly (esp.
  `max_results: 40` and the absence of extra fields).

**Task 3 — capture selection modes** (`evaluation/answer/capture.ts`,
`cli.ts`, `types.ts`, plus `judge.ts` for the unreachable skip)
- `--selection-mode` wiring (ruling 2). fixture-set: selection = the doc
  set's ids. no-selection: cite query per case → top-20 (cap
  `MAXIMUM_CONSULTED_DOCS = 20`) → selection; zero docs → `unreachable`
  (ruling 5, incl. the per-pass marker and the transport-failure ≠
  unreachable distinction).
- Selection recorded top-level (`{ mode, per-case selected_doc_ids }`) plus
  a per-pass copy; schema `@2`; fingerprint per ruling 4 (absent-selection
  hash unchanged — the pin test and @1 fixtures must not move).
- Answer retrieval gains `cite_doc_ids` = selection; `validDocs` filter per
  ruling 7. `judge.ts` job enumeration skips `unreachable` passes (same
  class as the answer-error skip).
- Tests: mode dispatch, zero-doc edge, fingerprint changes with mode but
  is byte-identical for selection-less captures (pin fixture),
  `cite_doc_ids` present in the answer retrieval request, validDocs filter,
  @1 captures still load, judge skips unreachable passes. In-task
  fallout: update the write-path schema assertions to @2 in `capture.test.ts`
  (read-path @1 tests stay) and the USAGE string in `cli.ts`.

**Task 4 — preflight** (`evaluation/answer/preflight.ts`)
- Existence gate per ruling 6 (snippet-derived, doc-scoped, wide pools,
  reranker off). `rank_gaps` recorded per case. Call estimate +1 retrieval
  per case in no-selection mode. Catalog/twins/synthesis-probe unchanged.
- Tests: variant-wording fixture passes existence while showing as a
  rank-gap; genuine absence still aborts; estimate.

**Task 5 — scoring** (`evaluation/answer/score.ts`)
- Per-case `selection_utilization` (share of selected docs contributing ≥1
  chunk to `passages_sent`) and `expected_doc_in_selection` (any expected
  doc or twin in the selection; no-selection mode). `unreachable` bucket in
  the header; unreachable negatives count as abstained. Mode in the header.
  Report the structural ceiling note (≤ `max_passages`) in README, not code.
- Tests: hand-computed numbers incl. the unreachable and zero-utilization
  edges; rank_gaps lifted from `capture.preflight` into the score report
  header beside the `unreachable` bucket (ruling 6).

**Task 6 — compare/pairwise guards** (`evaluation/answer/compare.ts`)
- `guardPair`/`compareReports` refuse differing selection modes with the
  reason (same class as gateway-vs-direct).
- Tests.

**Task 7 — CLI/labels/README + full gates**
- `run-judge`/`run-score` read @1 and @2 (ruling 1). `labels.ts` accepts
  labels bound to either schema's capture. README: selection modes,
  `unreachable`, `rank_gaps`, the parallel-safe no-selection-on-current-
  evalset note (ruling 2).
- Full gate run; fix fallout; conventional commits per task throughout.
- README notes the labeling window: `@2` captures cannot be labeled until
  the notebook's `@2` acceptance lands with the evalset PR (spec §8;
  §10 ordering keeps label production after that PR).

## Execution

Superpowers SDD, one task at a time:
- Before Task 1: the orchestrator derives the task briefs from the task
  sections below and seeds `progress.md` in
  `.pi-subagents/answer-eval-twostep/`.
- Per task: an implementer child executes the task brief at
  `.pi-subagents/answer-eval-twostep/task-N-brief.md` (TDD: failing tests
  first), commits (conventional, no Co-Authored-By), saves the review
  package diff, and writes `task-N-report.md`.
- Then a reviewer child reviews that task's diff against the brief and the
  spec; blocker findings loop back to a fixer before the next task.
- The orchestrator keeps `progress.md`, runs the final gates, and opens the
  PR (base `qa`, stacked on #399).
- Reviewer-dispatch note (known false negative): the `reviewer` builtin is
  read-only; the harness may report its no-edits completion as failed —
  always read the returned review text regardless of the status signal.
