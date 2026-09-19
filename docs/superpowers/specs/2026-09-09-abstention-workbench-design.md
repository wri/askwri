# Abstention Workbench — Design

**Date:** 2026-09-09
**Status:** Draft for review
**Branch:** `eval/abstention-workbench`
**Scope:** Committed eval-quality infrastructure for the off-topic abstention
signal: a blast-radius tool, a surface snapshot, an extraction corpus, and
service-side abstention debug fields. The signal fixes themselves (#402, #403)
are out of scope — they ride ON this infrastructure, each shipping with its
blast-radius table attached.

*Process note: implementation began from the #404 follow-up investigation
before this spec was written — the J-Space ledger held the state, but the
spec artifact lagged. Written retroactively 2026-09-09 at the operator's
process check; content is the verified record, not new design.*

## 1. Why

The abstention guardrail became honest in #404 (scoring `likely_off_topic`,
both directions). Its first full CI run (2026-09-09, post-deploy) shows what
it is measuring — and every number below is a reason fixes need an instrument
before they need another deploy:

| Finding | Evidence (2026-09-09) |
|---|---|
| 11 of ~57 positives (~19%) falsely flagged | eval-qa run: cite_01 4 (children pollution, micromobility, school bus health, world resources report) + answer_02 6 (q4, q5, q8, q10, q14, q15) + cite_02 1 (d14) |
| The signal is nondeterministic | d9: `true` (09-08 canary) → `false` (pre-deploy runs) → `true` (post-deploy CI, 3 probes); the false-flag sets differ between runs (q9 vs q4/q5) — per-deploy extraction lottery via `lru_cache` on `build_understanding_llm` |
| Root causes traced, all three verified | (a) extraction drifts to full clauses → framing 2-grams (`"in cities"`) match real titles (d9); (b) authors stored `"mulukutla, pawan"` — `ILIKE '%Pawan Mulukutla%'` can never match (d14); (c) entities live in summaries/content, not titles (q8/q9/q14; q10/q15 only in chunk text) |
| Case-tuning is a live danger | the stop-word 2-gram filter fixed d9 and silently flipped q5/q6 (their clearance rides on `"in china"`) — caught only by an ad-hoc blast-radius check that existed as throwaway scripts |

## 2. Decisions

- **Fix mechanisms, not cases.** Every policy change is justified by a
  principle that holds for unseen queries, and ships only with the full
  blast-radius table attached. (Protocol adopted after the stop-word filter
  refutation.)
- **The Python service stays authoritative** for the candidate policy; the
  TS mirror (`evaluation/lib/abstention-candidates.ts`) exists for pre-deploy
  evaluation and is cross-checkable against the service's
  `debug.abstention.matched_term`.
- **The extraction corpus is committed** (`evaluation/extractions/core-topics.json`),
  N samples per case — the per-deploy lottery becomes visible per-case
  flakiness instead of a recurring surprise.
- **Snapshots are timestamped, not committed** — every table names the corpus
  state it was computed against (same provenance principle as the harness's
  submodule pinning).
- **Non-goals:** no per-case knobs, no tuning-to-green UI, no eval-set
  fitting. The workbench makes tradeoffs visible, not hidden.

## 3. Pieces

1. `evaluation/lib/abstention-candidates.ts` (+ tests) — the candidate-policy
   mirror. Policies: `current` (mirrors the deployed service exactly) and
   `stopword-filtered` (the first tuning candidate — currently refuted by
   its own table).
2. `evaluation/diagnostics/snapshot-match-surface.ts` — timestamped
   catalog-surface snapshot. Documented approximation: superset of the title
   surface, blind to tags/aliases (q7 is the known blind-spot case).
3. `evaluation/diagnostics/refresh-core-topics.ts` +
   `evaluation/extractions/core-topics.json` — N-sample extraction corpus,
   same model/prompt/temperature as the sidecar
   (`gpt-5.4-mini`, temp 0, exact `_SYSTEM` from `understanding_llm.py`).
4. `evaluation/diagnostics/abstention-blast-radius.ts` — the table: per case ×
   per policy — negatives abstaining, positives cleared, at-risk positives,
   flips between policies.
5. Service: `core_topic_in_corpus` returns match details (matched term +
   matched surface); `debug.abstention` added to the query response (passes
   through the gateway's debug spread) — over time this replaces the snapshot
   approximation with the exact surface.

## 4. Verification

- Unit: the mirror's tests pin the service's documented policy, including
  both observed d9 extraction modes and the q6 flip that refuted the naive
  filter.
- Service: `test_core_topic_abstain.py` updated to the details contract.
- End-to-end: snapshot → refresh → blast-radius must reproduce the
  2026-09-09 manual analysis from committed tooling alone.
- Process: every subsequent abstain-surface PR carries its blast-radius
  table; eval-qa CI remains the post-deploy regression check, never the
  tuning target.
