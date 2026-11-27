# The cite evalsets cannot judge query expansion — holdout plan

**Date:** 2026-11-27
**Status:** diagnosis complete; holdout needs SME ground truth before it can run
Refs #498 (items 6, 9, 12), #530–#536.

## Finding: cite_01 is the dictionary's own exam

`DOMAIN_EXPANSIONS` has 20 phrases (`search-service/app/query_expansion.py`). Matching those
phrases against each case's question:

| set | cases | dictionary-mirrored |
|---|---|---|
| cite_01 | 11 | **10** (all but `q9`) |
| cite_02 | 16 | 3 (`d7` buses, `d8`/`d12` climate) |

The dictionary was written from cite_01's topics — land value capture, micromobility, hydrogen,
urban finance, children/pollution, Bangalore, Brazil. So a change that alters whether the
dictionary runs cannot be judged by cite_01: it is measuring the dictionary against the
material it was built from. That is exactly what the lane ablation measured — lanes off
restored the dictionary and "won" +2.8 pp on cite_01, while cite_02 (mostly dictionary-free)
moved the other way.

## Finding: one case is 8–9 points

cite_01 has 11 positives (9.1 pp per case), cite_02 13 (7.7 pp). Every delta this week —
+2.8, −2.5 — is under one case of either set. Set-level MAP cannot distinguish a real effect
from a single case changing its mind, and the gate's ±1 pp tolerance is finer than the
fixtures can resolve.

## Rule going forward

1. **cite_01 is a dictionary regression set.** It may detect that the dictionary broke; it
   cannot be evidence for or against expansion.
2. **Expansion changes are judged on non-dictionary cases.** Until a holdout exists, that
   means cite_02 with the three mirrored cases (`d7`, `d8`, `d12`) reported separately.
3. **Report per-case deltas, not only set MAP.** A set delta under ~8 pp is one case; say
   which one moved.

## Holdout: seed from real queries

`cite_mode_query_logs` holds **56 distinct queries** (425 rows) since March; 43 are free of
dictionary phrases. That is a real-query pool, not a synthetic one. The catch is ground truth:
relevance judgments must be human. Auto-labelling from current results would make the holdout
a photograph of the system it is meant to judge.

**Protocol.** Pick ~20 queries stratified by type (topic discovery, date/geo constrained,
cross-lingual, negative), dedupe variants, drop cases already represented. For each: write
`task_description`, mark `expected_external_ids` against the corpus, set `query_type` and
polarity. Promote to `evaluation/evalsets/evalset_cite_03.json` (any JSON in that directory
runs by default) and add its `no-facet-gate.json` entry after the first measured pass.
Acceptance: 15–20 cases, no case worth more than ~5 pp of the set, zero dictionary-mirrored
questions.

**Candidates** (distinct, deduped; count and last seen from the logs):

| # | query | n | last |
|---|---|---|---|
| 1 | How to build more equal cities | 166 | 2026-11-25 |
| 2 | Economic benefits of transit-oriented development | 75 | 2026-11-25 |
| 3 | infraestructura en ciudades | 54 | 2026-11-25 |
| 4 | Guidelines for safe bike lanes | 26 | 2026-10-30 |
| 5 | how did the pandemic affect public transport demand in Mexico? | 4 | 2026-09-03 |
| 6 | How can cities accelerate adoption of zero-emission trucks? | 4 | 2026-07-29 |
| 7 | Paratransit integration for cities | 3 | 2026-10-07 |
| 8 | Tell me more about equitable energy access for women in India | 2 | 2026-11-24 |
| 9 | Compact urban growth in India 2019-2023 | 2 | 2026-10-09 |
| 10 | publications on transit from the last five years | 2 | 2026-10-08 |
| 11 | freight decarbonization since 2022 | 2 | 2026-10-08 |
| 12 | freight reports in chinese | 2 | 2026-10-08 |
| 13 | How does large-scale electric vehicle adoption affect the power grid? | 2 | 2026-07-29 |
| 14 | Latest on building efficiency | 1 | 2026-11-25 |
| 15 | How does dockless bike-sharing affect travel behavior in Chinese cities? | 1 | 2026-11-18 |
| 16 | What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035? | 1 | 2026-11-18 |
| 17 | electric bus adoption in Kenya | 1 | 2026-10-08 |
| 18 | documents in spanish about street safety | 1 | 2026-10-08 |
| 19 | carbon reduction in Maryland | 1 | 2026-09-15 |
| 20 | the negative impact of unrestricted consumption | 1 | 2026-09-01 |

Excluded on purpose: Yantian Port, the Coalition for Urban Transitions, and the zero-emission
truck/China phrasings already covered by cite_02; `d14`'s author query; Spanish/Chinese
translation requests that duplicate `d12`/`q1`'s cross-lingual work.

## What not to do

- Do not auto-label ground truth from current top results (circular).
- Do not add a set with empty `expected_external_ids` to `evaluation/evalsets/` — the default
  run picks up every JSON there and it would score as an empty/negative set.
- Do not treat the ±1 pp gate as resolution on 11–13 cases.
