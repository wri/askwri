# Flag-on vs flag-off on QA — query-understanding promotion (#498 B, items 6 + 8)

**Date:** 2026-11-24
**Target:** `https://qa.askwri-app.org` — app commit `4b3a05e294dbac751d2361c1bbf26f0dbfc93a6e` (from the QA task
definition's image tag), `keyword=sparse`, `retrieval=postgres`, `env=qa`, **201 documents**
**Fixtures:** `evaluation/eval-review` @ `1dcbeabc909073c4141e8088cce8b7fef6de243a`
**Models in force:** `query_understanding_llm_model = gpt-5.4-mini`, `query_translation_model = gpt-5-mini`
(both from `search-service/app/config.py`); `QUERY_TRANSLATION_ENABLED` is unset in every environment, so
translation is off in both arms. The answer-mode knobs (`ASSIGNMENT`, `TASK_EFFORT`, evidence budget) do not
affect retrieval and are not recorded here.
**Arms:** `on` = the target's own configuration (all five flags live in QA). `off` = `expansion: false` in the
request, which is the search service's own flag-off guard: `understanding_active()` returns False, so the whole
understanding/expansion path — lanes and LLM sidecar — takes the byte-identical flag-off code path
(`search-service/app/understanding.py:62`). With lanes off, `domain_expansion = not lanes_on`, so **the off arm
is also the path production runs today.**

**The decomposability of the cost is the useful part:** `usage.calls` names each paid hop, so the
`query_understanding` line is visible per request when it runs.

## Method

`EVAL_EXPANSION` was added to `evaluation/run-evalset.ts` for this measurement (`evaluation/lib/gateway-body.ts`):
unset or `on` sends exactly `{query, mode}` — no retrieval params, per this README's rule — and `off` adds
`expansion: false`. Any other value fails before the first request, so a typo cannot record a default run as a
comparison. The arm is printed in the run header and stored as `expansion_arm` in every report JSON.

Two sets, two arms, three runs each (12 runs, ~20-35 s each):

```bash
npx tsx evaluation/run-evalset.ts evaluation/eval-review/evalsets/evalset_cite_01.json
EVAL_EXPANSION=off npx tsx evaluation/run-evalset.ts evaluation/eval-review/evalsets/evalset_cite_01.json
# …same for evalset_cite_02.json, three times per arm
```

## Results

| Set | Arm | doc MAP | attainable recall | negatives abstained | positives falsely flagged | service p50 / p95 | cost |
|---|---|---|---|---|---|---|---|
| cite_01 (11 pos) | on | 34.4% | 65.1% (55/87) | — (no negatives) | **1** (`q5_micromobility`) | 2072 / 2629 ms | $0.0220 |
| cite_01 | off | **36.4%** | **65.8%** (56/87) | — | 0 | **1128 / 1244 ms** | $0.0220 |
| cite_02 (13 pos, 3 neg) | on | **76.5%** | **88.4%** (86/104) | **3/3** | 0 | 2118 / 3038 ms | $0.0320 |
| cite_02 | off | 73.7% | 86.9% (84/104) | **0/3** | 0 | **1128 / 1268 ms** | $0.0320 |

**Arm separation was confirmed on live signals, not assumed:** with the flags on, cite_02's three
negatives all abstained and the harness warned about one false abstention; with them off, neither
happened (`likely_off_topic` is hard-wired false without the sidecar). A cold single query on each arm
also showed `usage.calls` differing by the `query_understanding` hop itself.

Chunk-grain metrics are `null` for both cite sets — they carry no passage ground truth, so the grain is
unscored, not zero. The reported cost is **identical across arms for a reason that matters** — see
"Cost: warm versus cold" below.

**Repeat spread: zero.** All three runs of each arm produced byte-identical MAP, attainable recall and cost, on
both sets. That is not model stability — the sidecar is `@lru_cache`d per process
(`search-service/app/understanding_llm.py:52`), so within one deployment every repeat is served from the first
draw. Only wall p95 moved between runs: ~1.3-1.6 s on the off arm, ~2.9-3.5 s on the on arm.

### Cost: warm versus cold

The sidecar's OpenAI call **is** metered: `app/usage_meter.py` prices `gpt-5.4-mini`, and
`understanding_llm.py` records its tokens as the `query_understanding` call. Recording sits inside the
`lru_cache`d body, so a cache **hit** makes no API call and correctly reports $0 — which is why both arms
show $0.0020/query here: the eval questions were already warm in the QA process when the matrix ran.

Measured cold, on a novel query against the same deployment:

```
arm on  → query_understanding  gpt-5.4-mini  286 in / 149 out  $0.000885
          embed ×3 (query + 2 variants) + rerank              $0.002000
arm off → rerank only                                         $0.002000
```

So a **cold** on-arm query costs ≈ $0.0029 against $0.0020 off — about +45% — while the warm figures above
understate it. Note also what the cold trace shows about latency: the on arm makes three embed calls to the off
arm's one, so the ~0.95 s delta is the expansion **lanes**, not only the sidecar; a warm query still pays it.

Per-case doc AP, every positive case (on − off, points; 9 of cite_01's 11 and 10 of cite_02's 13 moved,
the rest are exactly unchanged). The per-case deltas average to the table's MAP delta in both sets:

| cite_01 | on | off | Δ | cite_02 | on | off | Δ |
|---|---|---|---|---|---|---|---|
| q1_land_value_capture | 15.6 | 26.7 | −11.1 | d13_low-cost-air-quality-monitoring | 86.7 | 100.0 | −13.3 |
| q9_world_resources_report | 64.0 | 71.6 | −7.6 | d4_public-transport-financing | 55.2 | 58.6 | −3.4 |
| q3_children_pollution | 28.6 | 35.8 | −7.2 | d11_coalition-for-urban-transitions | 72.4 | 74.2 | −1.8 |
| q8_hydrogen | 21.7 | 27.8 | −6.1 | d12_climate-hazards-heat-resilience | 47.4 | 48.0 | −0.6 |
| q11_urban_finance_exclude_ebuses | 10.6 | 11.7 | −1.1 | d15_flooding-risk-informal-settlements | 60.1 | 60.6 | −0.5 |
| q10_urban_finance_since_2020 | 3.3 | 3.4 | −0.1 | d2_dockless-bike-sharing-discovery | 83.3 | 83.3 | 0.0 |
| q6_school_bus_health | 76.9 | 76.9 | 0.0 | d3_container-port-decarbonization | 100.0 | 100.0 | 0.0 |
| q7_jakarta_housing | 10.4 | 10.4 | 0.0 | d16_urban-tree-inventory-discovery | 100.0 | 100.0 | 0.0 |
| q2_bangalore_geography | 45.6 | 45.0 | +0.6 | d7_electric-buses-excluding-school-buses | 57.0 | 54.8 | +2.2 |
| q5_micromobility | 30.6 | 28.8 | +1.8 | d6_seizing-urban-opportunity-series | 100.0 | 93.8 | +6.2 |
| q4_climate_brazil | 71.0 | 62.3 | +8.8 | d5_public-transport-financing-since-2022 | 80.0 | 66.7 | +13.3 |
|  |  |  |  | d14_pawan-mulukutla-authorship | 79.5 | 64.0 | +15.5 |
|  |  |  |  | d1_zero-emission-heavy-duty-trucks | 73.1 | 54.5 | +18.6 |

## Sidecar determinism (item 8, measured properly)

Item 8 asked for "several runs and the spread". The repeats above answer a different question — the cache makes
them identical by construction. The real question is whether each **deploy** draws a representative sample,
since the first draw is frozen for the process's lifetime. Measured directly against the real sidecar: 27 eval
queries × 3 fresh samples each, `build_understanding_llm.cache_clear()` between samples so every sample is a
real API call, at the shipped `temperature=0` and `gpt-5.4-mini`.

Two independent probe runs, same queries, same model: **16/27 and 18/27 queries produced different output
across samples (59% and 67%).** Field counts varied too — run 1: `variants` 14, `facets` 7, `core_topic` 3,
`intent` 1; run 2: `variants` 15, `facets` 7, `core_topic` 3, `intent` 2. Which queries are unstable also moves
between runs, so read the headline as "roughly two-thirds of queries vary", not as a fixed list.

The unstable sets (run 1 / run 2) are in `evaluation/diagnostics/sidecar-determinism-probe.py`'s docstring and
the probe output; run 2's list: `q1`, `q2`, `q5`, `q6`, `q9`, `q11`, `d1`, `d2`, `d5`, `d7`, `d8`, `d9`, `d10`,
`d11`, `d12`, `d13`, `d14`, `d15`.

Unstable queries: `q2_bangalore_geography`, `q5_micromobility`, `q9_world_resources_report`,
`q10_urban_finance_since_2020`, `q11_urban_finance_exclude_ebuses`, `d1_…trucks`, `d2_…bike-sharing`,
`d3_container-port-decarbonization`, `d4_public-transport-financing`, `d6_seizing-urban-opportunity-series`,
`d7_electric-buses`, `d8_surveillance-tech-climate-resilience-negative`, `d10_nuclear-microreactors-negative`,
`d11_coalition-for-urban-transitions-partnership`, `d14_pawan-mulukutla-authorship`,
`d15_flooding-risk-informal-settlements-intersection`.

`core_topic` varying on a negative case is the sharpest consequence: `d10_nuclear-microreactors-negative`'s
abstain decision is downstream of a field that changes between samples.

## What this does and does not tell us

**Solid, draw-independent findings:**

1. **The off-topic guard exists only in the on arm.** cite_02's three negatives: 3/3 abstained with the flags
   on, 0/3 with them off. Production has no such guard in any configuration — with understanding off,
   `likely_off_topic` is hard-wired false (`app/main.py:2062-2073`). **The 3/3 is one draw, not a reliability
   claim:** abstention is decided from `core_topic`, and `core_topic` varies across samples — probe run 2 shows
   `d9_vertical-farming-negative` drawing two distinct core topics across three samples (`urban vertical farming`
   vs `urban vertical farming or rooftop agriculture`). Whether those variants flip the present/absent verdict
   needs `core_topic_in_corpus` against the corpus and was not measured, so the guard's false-negative rate on
   this negative set is **unmeasured**.
2. **The guard also misfires:** `q5_micromobility` is a positive case that the on arm flagged off-topic. This is
   the known coverage gap in #403/#498 item 11, now with a measured false-positive.
3. **The cost is ~0.95 s at service p50** (1128 → 2072-2118 ms) on every cold query. The sidecar's cache is per
   query, so a user's *first* search for any given query pays it — which is essentially every distinct search.

**The confounded part:** the treatment arm is a single draw from a stochastic sidecar. With 59% of queries
varying between samples, the ±2-3 MAP differences above are not distinguishable from draw-to-draw variation, so
**this measurement cannot say whether the flags help retrieval.** Anyone quoting "+2.8 on cite_02 / −2.0 on
cite_01" as the effect of the flags would be quoting one roll of the dice.

## Memo — against the bars pre-registered before the runs

**The governing rule, verbatim as committed at `4a9d320` (before any run):** promote if both sets' doc MAP is
within 1.0 pp of the off arm and service p95 grows by under 1.5 s; **hold** if either set loses more than 1.0 pp
or p95 grows by 1.5 s or more; narrower promotion if the sets disagree.

**Verdict: HOLD.** Two independent pre-registered triggers fire:

| Trigger | Measured | Bar |
|---|---|---|
| cite_01 doc MAP falls | −2.0 pp | more than 1.0 pp → hold |
| service p95 grows | cite_01 +1.39 s, cite_02 +1.77 s | 1.5 s or more → hold |

Independently of the bars, the determinism probe forecloses a promotion decision: the treatment arm is a single
draw from a sidecar that varies on roughly two-thirds of queries, so the MAP deltas above cannot be attributed to
the flags.

**Post-hoc clarification, disclosed.** The pre-registered bullets overlapped where a set both loses more than
1.0 pp and the sets disagree, and that overlap is what this run hit. The plan's step 5 now carries an exhaustive
decision table **written after these numbers were read**, which removes the ambiguity for future runs. Applied to
this data it would have selected "narrower promotion (sets disagree)" — the table's row for a set below −1.0 pp
takes no account of latency, which the original hold clause did. The original clause governs here, because it was
the rule in force when the runs were made and because it is the stricter of the two on two axes independently.
The plan says the table is post-hoc; nothing in this memo claims otherwise.

**Recommended order:**

1. **Make the sidecar deterministic across deploys** (small code change): persist the per-query result by query
   hash instead of `lru_cache`-ing it per process. That removes the per-deploy lottery, makes every future eval
   reproducible, and is the precondition for the rest.
2. **Then measure per-component** — three arms, not two: all off / deterministic tier only
   (`QUERY_UNDERSTANDING_ENABLED` without the LLM sidecar and lanes) / everything. The deterministic tier is
   cheap and deterministic and is what the tech note's chips and spelling suggestions need; the sidecar is the
   expensive, non-deterministic part. That experiment needs a QA flag flip and redeploy between arms — no
   per-flag request lever exists.
3. Only then decide item 9. If the off-topic guard is wanted sooner, note that it cannot be separated from the
   sidecar today: `core_topic` comes only from the LLM call. Its reliability is also unmeasured (see above).
4. The cost case for item 9 needs the **cold** figure (≈ $0.0029/query vs $0.0020, +45%), because these runs
   measured a warm sidecar cache. No metering change is needed — `usage.calls` already itemises the
   `query_understanding` hop; the eval harness's warm-run cost is the thing that has to be flagged.

## Reproduction

```bash
npx tsx evaluation/run-evalset.ts evaluation/eval-review/evalsets/evalset_cite_01.json     # on
EVAL_EXPANSION=off npx tsx evaluation/run-evalset.ts evaluation/eval-review/evalsets/evalset_cite_01.json
```

The determinism probe is committed as `evaluation/diagnostics/sidecar-determinism-probe.py`: it imports
`app.understanding_llm.build_understanding_llm`, calls it three times per eval question with
`cache_clear()` between calls, and diffs `{intent, facets, variants, core_topic}`.

The 14 report files for these runs are under `evaluation/results/` (git-ignored) with timestamps
`1795519343099`-`1795519732855`; the first two are exploratory, the remaining twelve are the matrix. Because
that directory never leaves this machine, the provenance others have is the target commit, the fixtures pin,
and the commands above.
