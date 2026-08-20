# P2 Query-Expansion Gate Results — v3.2 Re-Run

**Date:** 2026-08-20
**HEAD:** `f302757` (cite_01 v3.2 golden set, regenerated from eval-review submodule `2d31b72`)
**Rig:** Local search service against qa RDS, `RETRIEVAL_BACKEND=postgres KEYWORD_BACKEND=sparse`.

> **This is the v3.2 re-run.** The first gate run (commit `509cae4`) used evalset_cite_01 v3.1, which was stale — v3.2 reconciled expected docs against a 2026-08-17 corpus refresh and changed expected docs on 8 of 11 cite queries. The old P0 baselines (`evaluation/results/2026-08-19-p0-baseline-{cite,answer}.json`) were captured against v3.1 and are NOT comparable to v3.2 runs. See commit `f302757`.

## 1. Local suites

| Suite | Result |
|---|---|
| Leak detectors (`test_diagnostic_parity.py`, `test_query_nonblocking.py`) | 5 passed |
| Full suites | Not re-run (unchanged since first gate: 282 pytest / 395 jest) |

`git status` clean (at `f302757`); worktree confirmed.

## 2. Flag-OFF v3.2 baseline

Both flags at default OFF. No P0-baseline Δ (old P0 baselines are v3.1, different golden set).

### Cite

| Metric | Flag-off v3.2 |
|---|---|
| Overall recall | 0.7022 |
| Macro recall excl q10 | **0.7424** |
| Precision | 0.2919 |
| F1 | 0.3985 |
| Passed | 6/11 |

Report: `evaluation/results/eval-report-1787197542706.json`

### Answer-retrieval

| Aggregate | Flag-off v3.2 |
|---|---|
| chunk R | 0.33068 |
| chunk_adjacent R | 0.35417 |
| doc R | 0.75185 |

Report: `evaluation/results/answer-retrieval-1787197594899.json`

**Note:** The answer-retrieval golden set did not change between v3.1 and v3.2, so these numbers match the v3.1 P0 baselines exactly.

## 3. Flag-ON v3.2 results

Both flags ON (`QUERY_UNDERSTANDING_ENABLED=true QUERY_EXPANSION_LANES_ENABLED=true`).

### Cite

| Metric | Flag-off v3.2 | Flag-on v3.2 |
|---|---|---|
| Overall recall | 0.7022 | 0.5998 |
| Macro recall excl q10 | 0.7424 | **0.6198** |

Report: `evaluation/results/eval-report-1787197801503.json`

**Rule: cite macro recall (excl q10) ≥ 0.8583. Flag-on = 0.6198. FAIL.**

> **Threshold context:** The 0.8583 threshold was the v3.1 flag-off macro recall (excl q10), used as the floor. The v3.2 golden set is harder — the v3.2 flag-off baseline itself is 0.7424, which is already below 0.8583. The absolute threshold is stale relative to v3.2. The meaningful comparison is flag-on vs flag-off: the regression delta shrank from −0.1700 (v3.1) to −0.1226 (v3.2). The regression persists but is smaller.

### Per-case recall movement (cite)

| Query | Flag-off R | Flag-on R | Δ | alias_lane_size | lane_contribution | FN statuses |
|---|---|---|---|---|---|---|
| q1_land_value_capture | 0.6667 | 0.6667 | 0.0000 | 4 | dense=24 sparse=24 alias_sparse=25 | never_retrieved:1 |
| q2_bangalore_geography | 0.8333 | 0.5000 | −0.3333 | **0** | dense=9 sparse=4 | in_window_not_returned:2, below_window:1 |
| q3_children_pollution | 0.8333 | 0.6667 | −0.1667 | 2 | dense=7 sparse=2 alias_sparse=4 | in_window_not_returned:1, never_retrieved:1 |
| q4_climate_brazil | 0.6667 | 0.3333 | −0.3333 | 2 | dense=7 sparse=4 alias_sparse=5 | in_window_not_returned:1, below_window:1, never_retrieved:2 |
| q5_micromobility | 0.5833 | 0.5833 | 0.0000 | 4 | dense=14 sparse=20 alias_sparse=21 | never_retrieved:3 |
| q6_school_bus_health | 1.0000 | 0.8571 | −0.1429 | 4 | dense=10 sparse=10 alias_sparse=10 | in_window_not_returned:1 |
| q7_jakarta_housing | 0.7500 | 0.5000 | −0.2500 | 2 | dense=8 sparse=8 alias_sparse=8 | in_window_not_returned:1, never_retrieved:1 |
| q8_hydrogen | 1.0000 | 1.0000 | 0.0000 | 2 | dense=10 sparse=15 alias_sparse=14 | — |
| q9_world_resources_report | 1.0000 | 1.0000 | 0.0000 | 0 | dense=21 sparse=33 | — |
| q10_urban_finance_since_2020 | 0.3000 | 0.4000 | **+0.1000** | 6 | dense=1 sparse=4 alias_sparse=4 | in_window_not_returned:2, never_retrieved:4 |
| q11_urban_finance_exclude_ebuses | 0.0909 | 0.0909 | 0.0000 | 6 | dense=8 sparse=13 alias_sparse=14 | in_window_not_returned:3, never_retrieved:7 |

### q2_bangalore_geography — known gap (operator ruling, not a gate-fail contributor)

q2_bangalore_geography (alias_lane_size=0) recall moved 0.8333→0.5000. `bangalore` is in `scripts/tag-aliases-seed.json` `_unmapped`: "pure-geography entry, no matching topic place tag on qa (WRI India is facet=office, not topic)".

**Operator ruling (2026-08-19):** q2 is a known gap for the geo-facet follow-up, NOT a gate-fail contributor. The geo facet was deferred post-P2 pending exactly this gate evidence (see Task 7 notes in the plan file). This movement is the documented unmapped gap — the DOMAIN_EXPANSIONS retirement changed the raw sparse query, and the alias seed had no `bangalore` mapping to cover it. Recorded as a known gap.

### q10 year assertion

All 5 returned docs satisfy `year >= 2020` (DB-verified: 2024, 2022, 2024, 2025, 2024). **PASS.**

Notably, q10 improved with flags on in v3.2 (+0.1000, 0.3000→0.4000), flipping from the worst regression in v3.1 (−0.5000, 0.7500→0.2500).

### Answer-retrieval

| Aggregate | Flag-off v3.2 | Flag-on v3.2 | Rule |
|---|---|---|---|
| chunk | 0.33068 | 0.33270 | ≥ 0.3307 → **PASS** |
| chunk_adjacent | 0.35417 | 0.35810 | improved |
| doc | 0.75185 | 0.78889 | improved |

Report: `evaluation/results/answer-retrieval-1787197862301.json`

**Rule: answer chunk R ≥ 0.3307. Flag-on = 0.3327. PASS.**

## 4. Displacement attribution

`EVAL_LANE_ATTRIBUTION=1 EVAL_LABEL=p2-v32-attribution npm run eval:cite` (flag-on).

Report: `evaluation/results/eval-report-p2-v32-attribution-1787198162339.json`

| Displacement status | Count |
|---|---|
| never_retrieved | 19 |
| in_window_not_returned | 11 |
| below_window | 2 |
| **displaced_by_variant_lane** | **0** |

**Rule: zero `displaced_by_variant_lane`. PASS.** The 2× original-weight bound held — no variant-only node displaced a golden doc from the rerank window. All missed golden docs were in-window-not-returned (reranker ranked them out of the final top-k), below-window, or never-retrieved.

### Per-query attribution detail

| Query | alias_lane_size | false_negatives | statuses |
|---|---|---|---|
| q1 | 4 | 1 | never_retrieved:1 |
| q2 | 0 | 3 | in_window_not_returned:2, below_window:1 |
| q3 | 2 | 2 | in_window_not_returned:1, never_retrieved:1 |
| q4 | 2 | 4 | in_window_not_returned:1, below_window:1, never_retrieved:2 |
| q5 | 4 | 3 | never_retrieved:3 |
| q6 | 4 | 1 | in_window_not_returned:1 |
| q7 | 2 | 2 | in_window_not_returned:1, never_retrieved:1 |
| q8 | 2 | 0 | — |
| q9 | 0 | 0 | — |
| q10 | 6 | 6 | in_window_not_returned:2, never_retrieved:4 |
| q11 | 6 | 10 | in_window_not_returned:3, never_retrieved:7 |

## 5. Rule summary

| # | Rule | Result |
|---|---|---|
| 1 | Local suites green | PASS (leak detectors 5/5; full suites unchanged) |
| 2 | Cite macro recall (excl q10) ≥ 0.8583 | **FAIL** (0.6198; threshold stale — v3.2 flag-off itself is 0.7424) |
| 3 | Answer chunk R ≥ 0.3307 | PASS (0.3327) |
| 4 | q10 year ≥ 2020 | PASS (2024, 2022, 2024, 2025, 2024) |
| 5 | Zero displaced_by_variant_lane | PASS (0) |
| 6 | q2 alias_lane_size=0 recall moved | Known gap (operator ruling; geo facet deferred) — not a gate-fail contributor |

## 6. Comparison to v3.1 first run

### Macro recall (excl q10)

| | v3.1 | v3.2 |
|---|---|---|
| Flag-off | 0.8583 | 0.7424 |
| Flag-on | 0.6883 | 0.6198 |
| Regression Δ | −0.1700 | −0.1226 |

**The regression shrank but persists.** The flag-on→flag-off delta went from −0.1700 (v3.1) to −0.1226 (v3.2), a 28% reduction in the regression magnitude.

### Queries that moved (flag-off→flag-on)

| Query | v3.1 flag-off | v3.1 flag-on | v3.1 Δ | v3.2 flag-off | v3.2 flag-on | v3.2 Δ | Flip? |
|---|---|---|---|---|---|---|---|
| q1 | 1.0000 | 0.7500 | −0.2500 | 0.6667 | 0.6667 | 0.0000 | **Dissolved** (moved→stable) |
| q2 | 0.8333 | 0.5000 | −0.3333 | 0.8333 | 0.5000 | −0.3333 | Same (known geo gap) |
| q3 | 1.0000 | 0.8000 | −0.2000 | 0.8333 | 0.6667 | −0.1667 | Shrank |
| q4 | 1.0000 | 0.5000 | −0.5000 | 0.6667 | 0.3333 | −0.3333 | Shrank |
| q5 | 0.8571 | 0.8571 | 0.0000 | 0.5833 | 0.5833 | 0.0000 | Same (stable) |
| q6 | 1.0000 | 0.8333 | −0.1667 | 1.0000 | 0.8571 | −0.1429 | Similar |
| q7 | 0.7500 | 0.5000 | −0.2500 | 0.7500 | 0.5000 | −0.2500 | Same |
| q8 | 1.0000 | 1.0000 | 0.0000 | 1.0000 | 1.0000 | 0.0000 | Same (stable) |
| q9 | 1.0000 | 1.0000 | 0.0000 | 1.0000 | 1.0000 | 0.0000 | Same (stable) |
| q10 | 0.7500 | 0.2500 | −0.5000 | 0.3000 | 0.4000 | **+0.1000** | **Flipped to improvement** |
| q11 | 0.1429 | 0.1429 | 0.0000 | 0.0909 | 0.0909 | 0.0000 | Same (stable) |

**Key flips:**
- **q1 (land value capture):** Dissolved — moved (−0.2500) in v3.1, stable (0.0000) in v3.2. The v3.2 golden set lowered q1's flag-off baseline to 0.6667 (from 1.0000), and the flag-on didn't make it worse.
- **q10 (urban finance since 2020):** Flipped from worst regression (−0.5000) to slight improvement (+0.1000). The v3.2 golden set changed q10's expected docs, and the alias lane helped instead of hurt.

### Root cause (unchanged from v3.1)

The cite recall regression is still **reranker reordering, not displacement** (zero `displaced_by_variant_lane`). The alias lane widened the candidate pool enough that the reranker pushed golden docs out of the returned top-k. 11 `in_window_not_returned` cases — golden docs were in the rerank window but ranked below the final top-k cut. This is the Invariant 1 reordering effect: the alias lane reorders, and the reorder drops golden docs from the returned set.

The regression is smaller in v3.2 partly because the v3.2 golden set lowered several flag-off baselines (q1, q4, q5, q10, q11), meaning some golden docs were already harder to find even without the alias lane — leaving less room for the alias lane to make things worse, and in q10's case, the alias lane actually helped surface a golden doc.

## 7. Conclusion

The regression **shrank but persists**. The flag-on→flag-off delta reduced from −0.1700 to −0.1226 (28% smaller). Two queries flipped: q1 dissolved (moved→stable), q10 flipped from worst regression to slight improvement. The root cause remains reranker reordering (not displacement).

The absolute gate threshold (0.8583) is stale — it was the v3.1 flag-off baseline, and the v3.2 flag-off baseline (0.7424) is already below it. The gate rule as written FAILs, but the threshold should be recalibrated to the v3.2 flag-off baseline (0.7424) for future runs.

**Gate status: FAIL.**
**Cite macro recall rule fails: 0.6198 < 0.8583 (threshold stale; v3.2 flag-off itself is 0.7424).**
**Regression shrank: −0.1700 → −0.1226 (28% reduction). Root cause: reranker reordering (not displacement).**
**P3 BLOCKED — gate FAIL.** The alias lane investigation/retuning remains deferred to post-P2.

## Flags remain OFF

Both flags remain OFF in every deployed environment regardless of outcome. Activation (which realizes the DOMAIN_EXPANSIONS retirement) is a separate, gated ops step the operator controls. Physical deletion of `DOMAIN_EXPANSIONS` happens only after activation, as its own reviewed change.
