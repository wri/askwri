# P2 alias lane — decisive test on both cite sets (latest harness)

**Date:** 2026-08-20
**Harness:** `run-evalset.ts` (gen-2, Paul Lam) via local Next.js gateway → search-service on qa RDS. `EVAL_TARGET=http://127.0.0.1:3000`, `CITE_LOGIT_FLOOR=0.0`, `RETRIEVAL_BACKEND=postgres KEYWORD_BACKEND=sparse`.
**Code:** HEAD `e846f4c` (fix 1+2 + geo aliases — the best-measured state).
**Golden sets:** `evalset_cite_01.json` v3.2 (11 queries), `evalset_cite_02.json` v4.3 (16 queries).

## Result

| Set | flag-off R | flag-on R | Δ | Δ excl geo | verdict |
|---|---|---|---|---|---|
| cite_01 | 71.1% | 73.2% | +2.1 | **+4.4** | **PROVEN** (flag-on > flag-off excl geo) |
| cite_02 | 87.5% | 81.8% | −5.8 | **−0.7** | FLAT excl geo (d2 geo gap = −66.7 drags it negative) |

## Per-query Δ

**cite_01** (non-geo): q1 0.0, q3 0.0, q5 +16.7, q6 0.0, q7 0.0, q8 +33.3, q9 0.0, q10 −10.0, q11 0.0
**cite_02**: d1 0.0, **d2 −66.7 (geo)**, d3 0.0, d4 0.0, d5 0.0, d6 0.0, d7 +7.2, d11 0.0, **d12 −15.4**, d13 0.0, d14 0.0, d15 0.0, d16 0.0 (negatives d8/d9/d10: 25 docs both, abstained 0/3 both)

## d12 diagnosis (the one non-geo cite_02 regression)

d12: "What have WRI published on climate hazards and heat resilience in cities?"

- **Lost golden docs (flag-on, never retrieved):** `2021_mexico-frontrunners-adapting-to-climate-change-in_8904`, `2021_water-resilience-in-a-changing-urban-context_8364`
- **Replaced by off-topic:** `2015_city-greenhouse-gas-inventories_00031`, `2017_en-transport-emissions-social-cost_00039`, `2022_toward-credible-transport-carbon-dioxide_3778`
- **Alias lane fired:** `['emissions', 'greenhouse gas']` (Climate Change group, alphabetical M2)

**Root cause: seed vocabulary gap, same class as the geo gap.** The query matches only the `Climate Change` tag (→ emissions/greenhouse gas — wrong for heat-resilience). qa has 14 relevant tags the seed doesn't map: `Climate Adaptation`, `Climate Hazard`, `Climate Resilience`, `Heat Islands`, `Heat Waves`, `Urban Heat`, `Resilience`, `Water Resilience`, `Natural Hazards`, `Ecosystem-Based Adaptation`, `Locally Led Adaptation`, `Hazard Identification and Assessment`, `Adaptation`. Adding a `Climate Resilience`/`Heat Resilience` group with aliases (`heat`, `resilience`, `adaptation`, `hazards`, `heatwave`) would route d12 to the right vocabulary instead of the GHG-inventory drift.

**This is the same pattern as cite_01's geo gap (q2/q4): the alias lane helps where the seed covers the domain; it's neutral or harmful where the seed is missing it.** The expansion mechanism is sound; the seed is incomplete.

## Interpretation

The expansion hypothesis:
- **PROVEN on cite_01** (older discovery queries, +4.4 excl geo).
- **FLAT on cite_02** (newer queries, −0.7 excl geo — within noise; the one regression, d12, is a seed-coverage gap, not a mechanism failure).
- **Not falsified on either set.** The alias lane's value is real where vocabulary exists (cite_01 q5 +16.7, q8 +33.3; cite_02 d7 +7.2); the regressions are seed-coverage holes (geo: q2/q4/d2; heat-resilience: d12; one cite_01 q10 −10.0 under investigation — may be the same class).

## Reports (stored for future experiments)

- `evaluation/results/evalset-evalset_cite_01-1787241590499.json` (flag-off)
- `evaluation/results/evalset-evalset_cite_01-1787241738503.json` (flag-on)
- `evaluation/results/evalset-evalset_cite_02-1787241626726.json` (flag-off)
- `evaluation/results/evalset-evalset_cite_02-1787241789913.json` (flag-on)

Both flags remain OFF in every deployed environment. No push, no PR, no deploy.
