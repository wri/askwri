# Cite-mode evalsets on QA, before and after the GPT-6 model migration

Recorded 2026-11-19. Target: `https://qa.askwri-app.org` (`keyword=sparse`, `retrieval=postgres`, 201 documents).
Runner: `npm run eval:qa` (`evaluation/run-evalset.ts`) through CI workflow `eval-qa.yml`.

Both runs used the same fixtures, `evaluation/eval-review` at `fcf87208706b6f66e8741ce29d90094c5c5e7f51`
(CI fetches upstream `main`; the checked-in pin is older, `1dcbeab`, and gives different cite_01 numbers).
Cite mode is retrieval-only: none of the model changes touch it, so this is a no-regression record.

## Runs

| | Before | After |
|---|---|---|
| Workflow run | 44322316255 | 44356791667 |
| App commit on QA | `8f2a786` (before #493) | `8280d39` (live) |
| Models | per `docs/superpowers/handoffs/2026-11-18-qa-baseline-models.md` | the table below |

Merges between the two app commits: #493 (why, relates, alignment and answer model flips, answer provenance) and
#494 (route-sweep cost display; no runtime change). The eval posts only `{ query, mode: 'cite' }` to the search
service's gateway, which never calls the app's LLM routes. The cost column is the search service's own spend
(`usage.total_usd`: its translations and query embeddings), not the app routes' cost.

## Results

| Evalset | | MAP | Attainable recall | Latency p50 / p95 | Cost per query |
|---|---|---|---|---|---|
| `evalset_cite_01` (11 cases) | before | 38.2% | 67.3% (56/85) | 3.3 s / 4.9 s | $0.0025 |
| | after | 38.5% | 66.5% (55/85) | 3.2 s / 3.8 s | $0.0025 |
| `evalset_cite_02` (13 positive, 3 negative) | before | 76.3% | 87.8% (85/104) | 3.4 s / 6.5 s | $0.0025 |
| | after | 77.0% | 88.5% (86/104) | 3.3 s / 4.4 s | $0.0025 |

cite_02 negatives: 3/3 abstained in both runs.

Per-case average precision (AP), only where it moved:

| Case | Before | After |
|---|---|---|
| cite_01 `q2_bangalore_geography` | 46% | 50% |
| cite_01 `q9_world_resources_report` | 56% | 64% |
| cite_01 `q10_urban_finance_since_2020` | 10% | 3% |
| cite_01 `q11_urban_finance_exclude_ebuses` | 11% | 9% |
| cite_02 `d1_zero-emission-heavy-duty-trucks-discovery` | 73% | 67% |
| cite_02 `d4_public-transport-financing-discovery` | 55% | 67% |
| cite_02 `d7_electric-buses-excluding-school-buses` | 49% | 57% |
| cite_02 `d14_pawan-mulukutla-authorship` | 83% | 78% |

Weak both before and after: the date-constrained and topic-exclusion cases (`q10`, `q11`).
Movements go both ways and are under a point of MAP: drift, not a model effect.

## Model settings in force for "After" (`src/config/models.ts` at `8280d39`)

| Task | Model | Effort | Service tier |
|---|---|---|---|
| answer | `gpt-6.1-terra` | low | fast |
| prefilter | `gpt-6-luna` (inactive: `USE_NANO_FILTER` off on QA) | none | standard |
| why | `gpt-6-luna` | none | fast |
| relates | `gpt-6-luna` | none | standard |
| alignment | `gpt-6.1-terra` | low | fast |
| translate | `gpt-6-luna` | none | standard |

Answer evidence budget: 15 passages x 800 characters; `max_completion_tokens` 2000.
Fast tier bills at 2x the Standard rate (`FAST_TIER_PRICE_MULTIPLIER`). Standard list prices per 1M tokens
(input/output): luna $0.10/$0.50, terra $1/$5. No `MODEL_<TASK>` lever overrides were set.
Provenance of each route's model: `provenance.model` in the route response.

## Reproduce

```bash
git -C evaluation/eval-review fetch origin
git -C evaluation/eval-review checkout fcf87208706b6f66e8741ce29d90094c5c5e7f51
npm run eval:qa
```
