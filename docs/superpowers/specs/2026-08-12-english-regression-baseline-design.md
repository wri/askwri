# English Regression Baseline via eval:qa

**Date:** 2026-08-12
**Status:** Approved

## Problem

Dave's fear is that new (multilingual) documents degrade English retrieval.
The only ground truth that can show that is the old English golden set
(`evaluation/golden-dataset.json`, 11 cite queries, 74 expected docs). Its
historic numbers (recall 83%, precision 35%) came from local runs with
different parameters, so they cannot serve as the baseline for a
deployed-instance comparison. The baseline must be established by running
the old set against QA through the same gateway path that `eval:qa` uses —
once before the new SQL dump deploys (2026-08-13), and again after.

## Blocker

`run-evalset.ts` scores gen-2 sets keyed on `external_id` (PDF basename).
The old golden set keys on `expected_urls`. Two facts make the bridge cheap:

- The QA gateway already returns a `url` per doc
  (`src/app/api/llamaindex/route.ts:181`).
- `evaluation/lib/metrics.ts` already has `calculateUrlMetrics` with slug
  normalization, used by the local `run-cite-eval.ts`.

## Design

Extend `run-evalset.ts`: when a test case carries `expected_urls` instead of
external ids, score with `calculateUrlMetrics` against the gateway-returned
`url` fields. Everything else (report format, target/backend stamping,
per-case output) is shared.

Scope limits for this first pass:

- **Cite mode only.** The old set is a cite set; Answer has no trustworthy
  numbers to regress against.
- **No recall ceiling for URL sets.** The corpus-gap check keys on
  external_ids; URL↔filename matching is fuzzy and not worth building for
  a temporary bridge. URL sets report raw recall.
- **Not part of the default `eval:qa` sweep.** The old set runs by explicit
  path: `npx tsx evaluation/run-evalset.ts evaluation/golden-dataset.json`.
  The default sweep stays gen-2-only.

**This is a deliberate hack.** The URL branch must carry a comment stating
that it exists only so the gen-1 English golden set can serve as the
regression baseline, and that it can be removed when the gen-2 evalsets can
play that role — i.e., once they have expanded expected-document coverage
and a committed before/after run of their own, at which point
`golden-dataset.json` retires and the URL branch goes with it.

## Baseline procedure

1. Run the old set against QA today, before the new dump deploys.
2. Copy the report from `evaluation/results/` (gitignored) to
   `evaluation/baselines/2026-08-12-golden-en-qa.json` and commit it.
3. After the new dump deploys, rerun and compare per-query. Eyeball diff
   first; a compare script only if this becomes routine.

## Rejected alternatives

- **Convert the old set to gen-2 format** (URLs → external_ids via catalog):
  fuzzy slug↔filename mapping silently drops unmapped docs from the ground
  truth, and the derived fixture drifts from the canonical one.
- **Local `eval:cite` before/after:** requires a local search service per
  corpus state — the maintenance burden `eval:qa` exists to avoid.

## Testing

The scoring path (`calculateUrlMetrics`) is already covered where it is
tested today; the new code is glue. Verify by running the old set against QA
and sanity-checking per-query results against the known historic shape
(recall high, precision low). No new unit tests for the temporary branch.
