# Explicit negation — QA baseline (Task 8)

**Date:** 2026-11-26
**Target:** `https://qa.askwri-app.org`, commit `858bbca` (the #519 combined deploy)
**Fixtures:** vendored `evaluation/evalsets/evalset_cite_01.json` v3.2 (11 cases) and
`evalset_cite_02.json` v4.3 (16 cases); corpus 219 documents
**Arm:** both arms `EVAL_EXPANSION=off` — the deterministic path, no parser, no sidecar,
no lanes. Explicit facets still reach Stage 1.6.
**Facet arm:** a fixed per-case `EVAL_FACETS` manifest. Every other case runs with no
facets, so the delta is the exclusion mechanism, not the query-understanding tier.

## Method

Four runs, two sets × two arms:

| set | baseline arm | facet arm |
|---|---|---|
| cite_01 | no facets | `q11` excludes "electric buses"; `q4` excludes "Brazil" |
| cite_02 | no facets | `d7` excludes "school buses"; `d1` excludes "China" |

`q11`/`d7` are the intended exclusions. `q4`/`d1` are the bad-suggestion click
regressions: the sidecar names the query's own subject as an `excluded_keyword` (issue
#450's measured failure). Both arms send `return_intermediate_results: true` in the facet
arm, so `debug.excluded_doc_ids` is captured per case.

## Overall

| set | arm | MAP | attainable recall |
|---|---|---|---|
| cite_01 | baseline | 39.6 | 67.8 |
| cite_01 | exclusions | 34.2 | 58.7 |
| cite_02 | baseline | 73.7 | 86.9 |
| cite_02 | exclusions | 69.1 | 82.2 |

The overall drop is **driven almost entirely by the two bad-click cases**, which go to
zero. Read the per-case table before attributing the delta to negation.

## Per case

| case | kind | AP base → exclusions | aR base → exclusions | docs excluded | gold removed |
|---|---|---|---|---|---|
| `q11_urban_finance_exclude_ebuses` | intended | 11.7 → 15.2 | 18.2 → 18.2 | 16 | 1 (`2021_seizing-the-urban-opportunity_8690`) |
| `d7_electric-buses-excluding-school-buses` | intended | 54.8 → 50.0 | 57.1 → 50.0 | 11 | 1 (`2024_open-e-bus-blueprint_4307`) |
| `q4_climate_brazil` | bad click | 62.3 → 0 | 100.0 → 0 | 15 | 6 |
| `d1_zero-emission-heavy-duty-trucks-discovery` | bad click | 54.5 → 0 | 54.5 → 0 | 6 | 6 (all expected) |

**Leakage is zero in all four cases:** no returned document was in `excluded_doc_ids`.
The mechanism does what it says; the failures are input failures.

The intended exclusions are close to neutral: `q11` gains ~3.5 AP with recall unchanged,
`d7` loses ~4.8 AP / 7.1 recall by removing one gold document that genuinely discusses
school buses. The bad clicks are catastrophic and exact: excluding "Brazil" removes every
Brazil gold document from a Brazil query; excluding "China" removes all six expected
trucks documents.

That is the measured case for keeping negation **explicit-only**: confirmation protects
the good use (q11/d7) while making the bad use a visible, removable chip. It does not make
the bad click safe, and it does not justify auto-applying a sidecar suggestion.

## Caveats

- Sidecar off in both arms: this says nothing about auto-detected facets or the LLM tier.
  Those remain blocked on determinism (#498 item 9).
- Demotion was not measured; the branch ships exclusion only.
- `translation_pairs_enabled` and `answer_translation_enabled` are off in every
  environment, so the translation-exclusion guard is not exercised here.
- `excluded_doc_ids` can include paired documents that were not in the retrieved set
  (translation propagation). "Gold removed" is `excluded_doc_ids ∩ expected_ids`, not a
  count of documents that were in the candidate pool.
- The harness fix that makes an unset `EVAL_FACETS` work (`facetsManifest()` crashed on a
  null cache) is in this branch; these runs were made with it applied.

## Reproduction

```bash
export EVAL_EXPANSION=off
npx tsx evaluation/run-evalset.ts evaluation/evalsets/evalset_cite_01.json
EVAL_FACETS='{"q11_urban_finance_exclude_ebuses":[{"facet":"excluded_keyword","value":"electric buses"}],"q4_climate_brazil":[{"facet":"excluded_keyword","value":"Brazil"}]}' \
  npx tsx evaluation/run-evalset.ts evaluation/evalsets/evalset_cite_01.json
npx tsx evaluation/run-evalset.ts evaluation/evalsets/evalset_cite_02.json
EVAL_FACETS='{"d7_electric-buses-excluding-school-buses":[{"facet":"excluded_keyword","value":"school buses"}],"d1_zero-emission-heavy-duty-trucks-discovery":[{"facet":"excluded_keyword","value":"China"}]}' \
  npx tsx evaluation/run-evalset.ts evaluation/evalsets/evalset_cite_02.json
```
