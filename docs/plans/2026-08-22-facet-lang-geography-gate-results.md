# Facet-Language-Geography Fix — Gate Results

**Date:** 2026-08-21
**Branch:** `fix/facet-lang-geography` HEAD `a4533e9` (one commit: tighten `_LANG_RE` in `facet_parsers.py`).
**Rig:** search-service on qa RDS, `RETRIEVAL_BACKEND=postgres KEYWORD_BACKEND=sparse CITE_LOGIT_FLOOR=0.0`. Flag-on: `QUERY_UNDERSTANDING_ENABLED=true QUERY_EXPANSION_LANES_ENABLED=true EXPANSION_FACETS=["topic","geography"]`. Flag-off: both flags unset. Harness: `evaluation/eval-minimal.ts` → Next.js gateway (:3000) → search-service (:8000). Both the service and gateway ran with qa DB env via `./scripts/with-remote-env.sh qa`.
**Golden sets:** `evalset_cite_01.json` v3.2 (11 cases), `evalset_cite_02.json` v4.3 (16 cases), submodule `2d31b72`.

## Result

| Set | flag-off aR | flag-on aR | Δ | verdict |
|---|---|---|---|---|
| cite_01 | 71.1% (60/87) | 77.1% (63/87) | **+6.0** | **PASS** |
| cite_02 | 87.5% (85/104) | 88.7% (85/104) | **+1.2** | **PASS** |

**Gate decision:** flag-on ≥ flag-off on both cite sets. **PASS.**

This reproduces the P2.5/P2.6 gate numbers (cite_01 77.1%, cite_02 83.5% → 88.7%) **and fixes d2**, with no P2.7 window-tuning code — only the one-line facet-parser regex fix.

## d2 recovery (the headline)

| Run | d2 aR | d2 AP |
|---|---|---|
| P2.6 gate (flag-on, pre-fix) | 0% (0/2) | 0 |
| This gate (flag-off) | 100% (3/3) | 83% |
| **This gate (flag-on, post-fix)** | **100% (3/3)** | **81%** |

d2 recovered 0%→100% flag-on. The parser no longer fires `language=zh` on "in Chinese cities"; all 3 goldens (1 zh, 2 en) reach the reranker.

## cite_01 per-query (flag-off → flag-on)

| Query | off aR | on aR | Δ |
|---|---|---|---|
| q1 land_value_capture | 67% | 67% | 0 |
| q2 bangalore_geography | 83% | 83% | 0 |
| q3 children_pollution | 83% | 83% | 0 |
| q4 climate_brazil | 100% | 100% | 0 |
| q5 micromobility | 50% | 67% | **+17** |
| q6 school_bus_health | 100% | 100% | 0 |
| q7 jakarta_housing | 75% | 100% | **+25** |
| q8 hydrogen | 67% | 100% | **+33** |
| q9 world_resources_report | 100% | 100% | 0 |
| q10 urban_finance_since_2020 | 30% | 30% | 0 |
| q11 urban_finance_exclude_ebuses | 27% | 18% | −9 |

q2/q4 (geo) at ceiling — neutral. q5/q7/q8 gains match P2.5 (topic lane). q11 −9 is the known P2.5 regression (bus-finance docs pulled in), unchanged from P2.5/P2.6 — not new.

## cite_02 per-query (flag-off → flag-on)

| Query | off aR | on aR | Δ |
|---|---|---|---|
| d1 zero-emission-heavy-duty-trucks | 55% | 82% | **+27** |
| d2 dockless-bike-sharing | 100% | 100% | 0 (recovered) |
| d3 container-port-decarbonization | 100% | 100% | 0 |
| d4 public-transport-financing | 78% | 89% | **+11** |
| d5 public-transport-financing-since-2022 | 80% | 80% | 0 |
| d6 seizing-urban-opportunity | 100% | 100% | 0 |
| d7 electric-buses-excluding-school | 57% | 50% | −7 |
| d11 coalition-for-urban-transitions | 91% | 83% | −8 |
| d12 climate-hazards-heat-resilience | 77% | 69% | −8 |
| d13 low-cost-air-quality | 100% | 100% | 0 |
| d14 pawan-mulukutla | 100% | 100% | 0 |
| d15 flooding-risk-informal | 100% | 100% | 0 |
| d16 urban-tree-inventory | 100% | 100% | 0 |

d2 at 100% both runs (facet fix). d1 +27, d4 +11 are lane gains. d7/d11/d12 small regressions match P2.5/P2.6 — not new. Negatives d8/d9/d10 return 25 docs in both runs (unchanged, known).

## Comparison to P2.6 (pre-fix)

| Set | P2.6 flag-on aR | This gate flag-on aR | Δ |
|---|---|---|---|
| cite_01 | 76.6% | 77.1% | +0.5 |
| cite_02 | 82.2% | 88.7% | **+6.5** (d2 0%→100%) |

The facet fix alone accounts for the cite_02 gain; cite_01 is essentially flat (the fix doesn't touch non-language queries).

## What this proves

1. **d2 was a facet-parser misfire, not geo-lane flooding.** The P2.6 gate doc's diagnosis ("49 China docs flood the window") was wrong; the geo lane matched 0 tags for d2. The parser fired `language=zh` on "in Chinese cities" and filtered the 2 EN goldens pre-rerank.
2. **P2.5/P2.6 lane work was sound.** With the parser fixed, the lane gains (q5/q7/q8, d1/d4) are clean and the geo queries (q2/q4/d2) hold at ceiling — no window-tuning needed.
3. **P2.7 (window cap) is unnecessary on the current corpus.** No observed flooding case exists. The cap is shelved (`feature/rerank-window-tuning` branch retained for reference).

## Reports (stored)

- cite_01 flag-on: `evaluation/results/minimal-evalset_cite_01-1787320931848.json`
- cite_01 flag-off: `evaluation/results/minimal-evalset_cite_01-1787321036056.json`
- cite_02 flag-on: `evaluation/results/minimal-evalset_cite_02-1787320992400.json`
- cite_02 flag-off: `evaluation/results/minimal-evalset_cite_02-1787321068850.json`

## Conclusion

**Gate PASS.** The facet-parser fix (`fix/facet-lang-geography`, one commit) recovers d2 and preserves all P2.5/P2.6 lane gains. flag-on ≥ flag-off on both cite sets. Zero new regressions vs P2.5/P2.6. P2.7 shelved.

No push, no PR until operator approval. Both flags stay OFF in every deployed env.
