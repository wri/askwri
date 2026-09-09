# Abstention Workbench — Plan

**Date:** 2026-09-09
**Spec:** `docs/superpowers/specs/2026-09-09-abstention-workbench-design.md`
**Branch:** `eval/abstention-workbench` (from `origin/qa` @ `43aac3b`)
**Issue trail:** #354 (measurement, merged as #404) → #402 (d9 flakiness),
#403 (false abstentions) — both ride on this.

## Phases

- [x] **Phase 1 — Harness tools** (written 2026-09-09, before this plan
      existed — see the spec's process note):
  - `evaluation/lib/abstention-candidates.ts` + `.test.ts` (policy mirror)
  - `evaluation/diagnostics/snapshot-match-surface.ts`
  - `evaluation/diagnostics/refresh-core-topics.ts`
  - `evaluation/diagnostics/abstention-blast-radius.ts`
  - `.gitignore`: snapshots dir
- [x] **Phase 2 — Service debug fields**: `core_topic_in_corpus` returns
      `{present, matched_term, matched_surface}`; `debug.abstention` on the
      query response (core_topic + decision). Update
      `search-service/tests/test_core_topic_abstain.py` to the new contract.
      Gateway needs no change (debug spread passes it through).
      *Done 2026-09-09 under TDD: RED (8 failing tests) → GREEN (8 passing).*
- [x] **Phase 3 — Verification battery**: jest (evaluation/) 252/252 incl.
      9 new; tsc + eslint clean; full search-service pytest 335 passed /
      204 skipped, no collateral damage; end-to-end workbench run:
      snapshot (201 items) → extraction corpus (43 cases × 3 samples,
      8 flaky) → blast-radius table reproducing the manual analysis and
      extending it (d8 also has a long-clause mode; stopword-filtered
      confirmed strictly worse: +2 at-risk positives).
- [ ] **Phase 4 — PR** to `qa` with the reproduced table attached; CI green;
      post-merge eval-qa run read as regression check only.

## Exit criteria

The workbench is done when a policy change can be evaluated with one command
(`abstention-blast-radius.ts`), against a committed extraction corpus and a
timestamped surface, with the service's own decision visible in
`debug.abstention` — and when the #402/#403 fixes use it before they deploy.

## Review checkpoint

After Phase 3, walk the table with the operator: is the snapshot
approximation acceptable until the debug surface replaces it, and is the
committed extraction corpus refreshed often enough (per investigation vs.
scheduled)?
