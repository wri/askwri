# Facet shaping vs filtering — Design

- **Date:** 2026-11-26
- **Issue:** [wri/askwri#522](https://github.com/wri/askwri/issues/522) (parent #450)
- **Status:** Proposed; awaiting approval
- **Branch:** `fix/522-facet-shaping` (targets `qa`)
- **Scope:** small — one eval-only service knob, one probe evalset, and one measured baseline.

## Problem

#450's open question, per facet type: should a facet **filter** the candidate pool or **shape**
it? The types that shape (topic, geography) already do so as tag lanes. The rest are
constraints and only filter — post-fusion, pre-rerank (`main.py:1672`, `facet_filter.py`).
Nobody has measured whether a lane or a score boost would beat the filter for recency, series
or office. #522 says run the experiment before building lanes.

## What exists today (verified on `origin/qa` @ `858bbca`)

| Concern | Where | State |
| Filter application point | `main.py:1672-1707` → `facet_filter.apply_facet_filters` | Only `action="hard"` facets; matching logic inline in one loop |
| Per-type policy | `understanding.FACET_MODES` | `filter` for year/date/language/office/program, `negate` for `excluded_keyword` |
| Shape-lever surface | `bedrock_rerank._select_candidates(nodes, settings.rerank_candidates)` | Takes the fused order as given; window is 100 |
| RRF | `main.py:381` | `score += lane_weight / (60 + rank + 1)` |
| Eval lever | `evaluation/lib/gateway-body.ts` | `EVAL_EXPANSION=off`, per-case `EVAL_FACETS` |
| Removed gold / leakage | `debug.excluded_doc_ids` → harness | Landed with #450 |
| Determinism | `evaluation/baselines/2026-11-24-flag-on-vs-off-qa.md:53` | Repeat spread **zero** on the `EVAL_EXPANSION=off` path |

Nothing boosts or lanes a facet. There is no per-type evidence either way.

## Decisions taken

1. **The instrument is a pre-rerank boost, not a lane.** A lane is new retrieval machinery; a
   boost is the same Stage 1.6 point with the opposite sign, so arms 2 and 3 differ in exactly
   one thing. If a boost wins, a lane is the next question, not this one.
2. **Say what a boost can and cannot do.** Pre-rerank, it changes which documents reach the
   100-candidate rerank window — **pool admission**, not ranking. The baseline reports it as
   such. A ranking claim would need a post-rerank boost, which is a different experiment.
3. **Positive constraint facets only.** `year_min`/`year_max`/`date_min`/`date_max`/`language`/
   `office`/`program` can be boosted. `excluded_keyword` keeps filtering in both modes: "remove
   this" cannot be expressed as a nudge, and #520 already measured that path.
4. **One weight, `1.0`.** One RRF vote at rank 1, the same unit the fusion code already uses.
   A sweep is a second experiment; #522 asks for three arms.
5. **Env knob, no request field.** `FACET_MODE` / `FACET_BOOST_WEIGHT` in `config.py`, default
   `filter`. The `/query` request contract stays exactly as it is. Cost: the boost arm needs a
   QA deploy with `FACET_MODE=boost`, then a revert. Accepted; the alternative is new contract
   surface for an experiment.
6. **Office gets a constructed probe case**, since neither set names an office. Gold is the
   corpus-derived intersection of the source case's gold with a real office, so no relevance
   judgement is invented here.
7. **Series is blocked, and is reported as blocked.** No document has any series value:
   `program_series` is absent from QA's `source_metadata.metadata` for all 219 searchable
   documents, so `pg_store.py:169` yields `""` and the facet removes everything it is applied
   to. In boost mode the same query would match nothing, so all three arms would be identical
   by construction — a guaranteed null result, not a finding. Deferred to #523.

## The lever

`config.py`:

```python
facet_mode: Literal["filter", "boost"] = "filter"
facet_boost_weight: float = 1.0   # one RRF vote at rank 1 = weight / (60 + 1)
```

`facet_filter.py`: extract the per-node matching test out of `apply_facet_filters` into one
predicate used by both paths, so filter and boost can never drift apart.

```python
def _matches(nws, md, constraints) -> bool: ...          # the current inline test
def apply_facet_filters(...)            # keep only matching nodes (unchanged behaviour)
def boost_facet_matches(nodes, facets, docs_meta, weight)
    # -> (nodes sorted by score, boosted_ids)
```

`main.py` Stage 1.6: when `settings.facet_mode == "boost"`, call `boost_facet_matches` instead
of `apply_facet_filters` for the positive facets; negations still go through
`excluded_doc_ids` + filtering. `debug` gains two additive keys (it is `Dict[str, Any]`):

- `"facet_mode"` — always, so every run artifact proves which arm answered.
- `"boosted_doc_ids"` — sorted, under `return_intermediate_results`, mirroring `excluded_doc_ids`.

## Pre-registered experiment

Written into the baseline document **and committed before the first run**.

**Arms** (per type, all with `EVAL_EXPANSION=off`):

| arm | service env | harness |
|---|---|---|
| 1 no facet | `FACET_MODE=filter` | `EVAL_FACETS` names no case |
| 2 hard filter | `FACET_MODE=filter` | per-case facet manifest |
| 3 boost | `FACET_MODE=boost` | the same manifest |

Arm 1 is shared across types: it is the same no-facet baseline for both.

**Cases**

| type | set | case | facet | gold |
|---|---|---|---|---|
| recency | cite_01 | `q10_urban_finance_since_2020` | `year_min` 2020 | 10 |
| recency | cite_02 | `d5_public-transport-financing-since-2022` | `year_min` 2022 | 5 |
| office | probe | `office_q10_mexico` | `office` "WRI Mexico" | 3 (q10 gold ∩ Mexico) |
| office | probe | `office_d7_india` | `office` "WRI India" | 4 (d7 gold ∩ India) |
| series | — | blocked | — | — |

The office probe lives in `evaluation/evalsets/facet-office-probe.json`, not in the
`eval-review` submodule: it is a mechanism probe, not a golden set. Each case's question is
rewritten to name the office, so the facet is implied by the query rather than injected.

**Metrics, per case and per set:** MAP, attainable recall, gold removed, leakage, plus for
arm 3 the number of gold documents the boost admitted into the rerank window
(`boosted_doc_ids ∩ expected`, and `∩ returned`). Reported separately, never pooled with the
facet cases' neighbours.

**Tolerance:** zero MAP, zero aR. Justified, not assumed: the `EVAL_EXPANSION=off` path had a
repeat spread of exactly zero in the 2026-11-24 baseline. If any arm's repeat run differs, the
run is void and the spread is recorded instead of a verdict.

**Decision rule (pre-registered):** a boost replaces the filter for a type **only if** all
three hold on both sets —

1. the facet case's attainable recall is **higher** in arm 3 than in arm 2;
2. MAP on that set is **not lower** in arm 3 than in arm 2 (tolerance zero);
3. no gold document outside the facet cases is lost in arm 3 relative to arm 1.

Otherwise the type is recorded as **constraint** and the filter stays. A tie is a constraint.
"Improves but costs MAP" is not a promotion. Nothing is built for a type whose verdict is
constraint.

## Non-goals

- Lanes, tag lanes for metadata, RRF reweighting, post-rerank boosts, a weight sweep.
- Any change to what users see today: `filter` is the default in every environment.
- Series/program canonicalization (#523), negation (#520), sidecar determinism (#498).
- Retrieval tuning unrelated to facets.

## Risks

- **Thin office probe.** 3 and 4 gold documents: a single document moves recall by ~25-33
  points. Mitigated by reporting counts, not just percentages, and by treating the probe as a
  mechanism check whose only promotable outcome is a clear, count-level win.
- **Boost `1.0` may be too weak or too strong** to change window membership for these facets.
  Reported as "gold admitted into the window": zero admitted means the weight was too weak for
  this pool and the arm is inconclusive, not that shaping fails. That distinction goes in the
  baseline.
- **Two deploys** for one experiment (lever, then `FACET_MODE=boost`, then revert). Each is a
  QA-only chore; the run artifacts name the mode so a mislabelled arm cannot pass unnoticed.

## Test plan

- `test_facet_filter.py`: `_matches` unchanged for every existing case (the refactor proves
  itself against the current suite); boost keeps every node and raises only matching scores;
  `excluded_keyword` still removes in boost mode; weight 0 changes nothing; boosted order is
  score-descending.
- `test_explicit_facets_flag_off.py`: with understanding off, `FACET_MODE=boost` boosts an
  explicit facet rather than filtering, and `debug.boosted_doc_ids` is populated.
- Eval: the three arms above, recorded under `evaluation/baselines/`.

## Rollout

Lever lands on `qa` with `filter` as the default — production and QA behaviour unchanged.
The boost arm is a temporary QA env flip for the run, reverted afterwards. Per-type verdicts
go into #450 as a comment; no facet type changes mode on the strength of this experiment alone.
