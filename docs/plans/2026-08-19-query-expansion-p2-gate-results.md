# P2 Query-Expansion Gate Results

**Date:** 2026-08-19
**HEAD:** `183a842` (Tasks 1–7 merged)
**Rig:** Local search service against qa RDS, `RETRIEVAL_BACKEND=postgres KEYWORD_BACKEND=sparse`, matching P0 baselines.
**P0 baselines:** `evaluation/results/2026-08-19-p0-baseline-{cite,answer}.json`

## 1. Local suites

| Suite | Result |
|---|---|
| Python (`pytest tests/ -v`) | 282 passed, 197 skipped |
| Jest (`npm test`) | 395 passed, 232 skipped |
| Lint (`npm run lint`) | clean |
| Format (`npm run format:check`) | 3 pre-existing warnings (Tasks 6/7, not this task) |

## 2. Flag-OFF re-run (byte-identical proof)

Both flags at default OFF.

### Cite

| Metric | P0 | Flag-off | Δ |
|---|---|---|---|
| Recall | 0.8485 | 0.8485 | 0.0000 |
| Precision | 0.2777 | 0.2804 | +0.0026 |
| F1 | 0.4059 | 0.4093 | +0.0034 |

Per-case recall: all 11 identical to P0 (Δ=0.0000). P/F1 wiggle in q8/q9/q10 is the known reranker score rounding (P1 precedent).

### Answer-retrieval

| Aggregate | P0 R | Flag-off R | Δ |
|---|---|---|---|
| chunk | 0.33068 | 0.33068 | 0.0000 |
| chunk_adjacent | 0.35417 | 0.35417 | 0.0000 |
| doc | 0.75185 | 0.75185 | 0.0000 |

**Rule: flag-off recall Δ=0.0000. PASS. No leak outside `lanes_active`.**

## 3. Flag-ON run

Both flags ON (`QUERY_UNDERSTANDING_ENABLED=true QUERY_EXPANSION_LANES_ENABLED=true`).

### Cite

| Metric | P0/flag-off | Flag-on |
|---|---|---|
| overall recall | 0.8485 | 0.6485 |
| macro recall excl q10 | **0.8583** | **0.6883** |

**Rule: cite macro recall (excl q10) ≥ 0.8583. Flag-on = 0.6883. FAIL.**

### Per-case recall movement (cite)

| Query | Flag-off R | Flag-on R | Δ | alias_lane_size | lane_contribution |
|---|---|---|---|---|---|
| q1_land_value_capture | 1.0000 | 0.7500 | −0.2500 | 4 | dense=23 sparse=23 alias_sparse=24 |
| q2_bangalore_geography | 0.8333 | 0.5000 | −0.3333 | **0** | dense=9 sparse=4 |
| q3_children_pollution | 1.0000 | 0.8000 | −0.2000 | 2 | dense=7 sparse=2 alias_sparse=4 |
| q4_climate_brazil | 1.0000 | 0.5000 | −0.5000 | 2 | dense=7 sparse=4 alias_sparse=5 |
| q5_micromobility | 0.8571 | 0.8571 | 0.0000 | 4 | dense=14 sparse=20 alias_sparse=21 |
| q6_school_bus_health | 1.0000 | 0.8333 | −0.1667 | 4 | dense=10 sparse=10 alias_sparse=10 |
| q7_jakarta_housing | 0.7500 | 0.5000 | −0.2500 | 2 | dense=8 sparse=8 alias_sparse=8 |
| q8_hydrogen | 1.0000 | 1.0000 | 0.0000 | 2 | dense=10 sparse=15 alias_sparse=14 |
| q9_world_resources_report | 1.0000 | 1.0000 | 0.0000 | 0 | dense=21 sparse=33 |
| q10_urban_finance_since_2020 | 0.7500 | 0.2500 | −0.5000 | 6 | dense=1 sparse=4 alias_sparse=4 |
| q11_urban_finance_exclude_ebuses | 0.1429 | 0.1429 | 0.0000 | 6 | dense=8 sparse=13 alias_sparse=14 |

### q2_bangalore_geography — known gap (operator ruling, not a gate-fail contributor)

q2_bangalore_geography (alias_lane_size=0) recall moved 0.8333→0.5000. `bangalore` is in `scripts/tag-aliases-seed.json` `_unmapped`: "pure-geography entry, no matching topic place tag on qa (WRI India is facet=office, not topic)".

**Operator ruling (2026-08-19):** q2 is a known gap for the geo-facet follow-up, NOT a gate-fail contributor. The geo facet was deferred post-P2 pending exactly this gate evidence (see Task 7 notes in the plan file). This movement is the documented unmapped gap — the DOMAIN_EXPANSIONS retirement changed the raw sparse query, and the alias seed had no `bangalore` mapping to cover it. Recorded as a known gap.

### q10 year assertion

All 5 returned docs satisfy `year >= 2020` (DB-verified: 2024, 2022, 2024, 2025, 2024). **PASS.**

### Answer-retrieval

| Aggregate | P0/flag-off R | Flag-on R | Rule |
|---|---|---|---|
| chunk | 0.33068 | 0.33270 | ≥ 0.3307 → **PASS** |
| chunk_adjacent | 0.35417 | 0.35810 | improved |
| doc | 0.75185 | 0.78889 | improved |

**Rule: answer chunk R ≥ 0.3307. Flag-on = 0.3327. PASS.**

## 4. Displacement attribution

`EVAL_LANE_ATTRIBUTION=1 EVAL_LABEL=p2-attribution npm run eval:cite` (flag-on).

| Displacement status | Count |
|---|---|
| never_retrieved | 7 |
| in_window_not_returned | 12 |
| below_window | 4 |
| **displaced_by_variant_lane** | **0** |

**Rule: zero `displaced_by_variant_lane`. PASS.** The 2× original-weight bound held — no variant-only node displaced a golden doc from the rerank window. All missed golden docs were in-window-not-returned (reranker ranked them out of the final top-k), below-window, or never-retrieved.

### Per-lane contribution (spec §6)

See `lane_contribution` in the per-case table above. The `alias_sparse` lane contributed retrieved docs on every query where `alias_lane_size > 0`. It did not fire on q2 or q9.

### Per-query attribution detail

| Query | alias_lane_size | false_negatives | statuses |
|---|---|---|---|
| q1 | 4 | 1 | in_window_not_returned:1 |
| q2 | 0 | 3 | in_window_not_returned:2, below_window:1 |
| q3 | 2 | 1 | in_window_not_returned:1 |
| q4 | 2 | 2 | in_window_not_returned:1, below_window:1 |
| q5 | 4 | 1 | never_retrieved:1 |
| q6 | 4 | 1 | in_window_not_returned:1 |
| q7 | 2 | 2 | in_window_not_returned:1, never_retrieved:1 |
| q8 | 2 | 0 | — |
| q9 | 0 | 0 | — |
| q10 | 6 | 3 | in_window_not_returned:1, below_window:2 |
| q11 | 6 | 6 | in_window_not_returned:2, never_retrieved:4 |

## 5. Rule summary

| # | Rule | Result |
|---|---|---|
| 1 | Local suites green | PASS |
| 2 | Flag-off recall Δ=0.0000 (cite + answer) | PASS |
| 3 | Cite macro recall (excl q10) ≥ 0.8583 | **FAIL** (0.6883) |
| 4 | Answer chunk R ≥ 0.3307 | PASS (0.3327) |
| 5 | q10 year ≥ 2020 | PASS |
| 6 | Zero displaced_by_variant_lane | PASS (0) |
| 7 | q2 alias_lane_size=0 recall moved | Known gap (operator ruling; geo facet deferred) — not a gate-fail contributor |

## 6. Root cause analysis

The cite recall regression is broad: 6 of 11 queries dropped recall (q1, q2, q3, q4, q6, q7, q10). Five of those had the alias lane active (alias_lane_size > 0); q2 had alias_lane_size=0 (DOMAIN_EXPANSIONS retirement only, known geo gap — see §3).

**Root cause: broad reranker reordering.** The alias lane widened the candidate pool enough that the reranker pushed golden docs out of the returned top-k. The displacement attribution confirms this: 12 `in_window_not_returned` cases — golden docs were in the rerank window but ranked below the final top-k cut. The 2× original-weight bound held at the window level (zero `displaced_by_variant_lane`), so this is **NOT displacement** — it is **reordering**. The alias lane added candidates that shifted reranker scores; golden docs survived into the window but lost rank position to alias-surfaced candidates within the returned top-k.

This is the Invariant 1 reordering effect in its strongest form: the alias lane reorders, but the reorder is large enough to drop golden docs from the returned set (not just reorder within it).

## Flags remain OFF

Both flags remain OFF in every deployed environment regardless of outcome. Activation (which realizes the DOMAIN_EXPANSIONS retirement) is a separate, gated ops step the operator controls. Physical deletion of `DOMAIN_EXPANSIONS` happens only after activation, as its own reviewed change.

The alias lane needs investigation/retuning before the gate can pass — that work is OUT of P2 scope (post-P2).

---

**Gate status: FAIL.**
**Cite macro recall rule fails: 0.6883 < 0.8583 (6/11 queries dropped recall).**
**Root cause: reranker reordering (not displacement). Alias lane investigation deferred to post-P2.**
**P3 BLOCKED — gate FAIL.**
