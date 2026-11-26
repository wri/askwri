# Facet shaping vs filtering — QA baseline (#522)

**Status:** PRE-REGISTERED — written and committed before any run. The numbers below
are filled in afterwards; the decision rule is not.
**Issue:** [wri/askwri#522](https://github.com/wri/askwri/issues/522) (parent #450)
**Target:** `https://qa.askwri-app.org`, QA deploy of `fix/522-facet-shaping`
**Fixtures:** `evalset_cite_01.json` v3.2 (11 cases), `evalset_cite_02.json` v4.3 (16 cases),
and `evaluation/evalsets/facet-office-probe.json` v1.0 (2 cases, constructed here)
**Arm:** all arms `EVAL_EXPANSION=off` — deterministic path, no parser, no sidecar, no lanes.
The arm is chosen by **service env** (`FACET_MODE`), not by the request: the request bodies
are identical across arms 2 and 3. `debug.facet_mode` in each report JSON is the evidence of
which arm actually answered.

## Question

Per facet type, does a **shape** lever (keep everything, reward the matching documents) beat
the current **filter** (drop the non-matching ones)? #450 asks it; #522 says measure before
building lanes or score boosts.

## Arms

| arm | service env | `EVAL_FACETS` |
|---|---|---|
| 1 no facet | `FACET_MODE` unset (`filter`) | names no case, or `{}` |
| 2 hard filter | `FACET_MODE` unset (`filter`) | per-case manifest below |
| 3 boost | `FACET_MODE=boost` | the same manifest as arm 2 |

Arm 1 is shared: the same no-facet baseline serves both types.

## Cases

| type | set | case | facet | gold |
|---|---|---|---|---|
| recency | cite_01 | `q10_urban_finance_since_2020` | `year_min` = 2020 | 10 |
| recency | cite_02 | `d5_public-transport-financing-since-2022` | `year_min` = 2022 | 5 |
| office | probe | `office_q10_mexico` | `office` = "WRI Mexico" | 3 |
| office | probe | `office_d7_india` | `office` = "WRI India" | 4 |
| series | — | **blocked** | — | — |

The office probe's gold is the source case's gold intersected with a real office, computed
against QA RDS on 2026-11-26, and its questions are rewritten to name the office. It is a
mechanism probe, not a golden set.

**Series is blocked, and is reported as blocked rather than run.** No document in QA carries
a series value: `program_series` is absent from `source_metadata.metadata` for all 219
searchable documents (checked 2026-11-26), so `pg_store.py` yields `""` for every document.
A hard filter on any series removes the whole pool; a boost on any series rewards nothing.
Arms 1, 2 and 3 would be identical by construction — a guaranteed null, not a finding.
Deferred to #523.

## Metrics

Per case and per set: MAP (AP per case), attainable recall, gold removed, leakage. For arm 3
additionally `boosted_doc_ids ∩ expected` (gold the boost rewarded) and
`boosted_doc_ids ∩ returned`, read from `debug.boosted_doc_ids`. Counts are reported next to
every percentage: the office probe's gold is 3 and 4 documents, where one document is ~25-33
recall points.

**What arm 3 is, and is not.** The boost applies pre-rerank, so it changes which documents
enter the 100-candidate rerank window — **pool admission**. It is not a ranking lever and is
not reported as one.

**Tolerance: zero MAP, zero aR.** The `EVAL_EXPANSION=off` path had a repeat spread of exactly
zero on 2026-11-24 (`2026-11-24-flag-on-vs-off-qa.md:53`). Arm 1 is therefore re-run once per
set as a determinism check: any difference voids the run and the spread is recorded in place
of a verdict.

## Decision rule (pre-registered — do not edit after the first run)

A boost replaces the filter for a type **only if all three hold, on both sets of that type**:

1. the facet case's attainable recall is **higher** in arm 3 than in arm 2;
2. MAP on that set is **not lower** in arm 3 than in arm 2 (tolerance zero);
3. no gold document outside the facet cases is lost in arm 3 relative to arm 1.

Otherwise the type is recorded as **constraint** and the filter stays.

- A **tie is a constraint.** "Improves recall but costs MAP" is not a promotion either.
- If `boosted_doc_ids ∩ expected` is empty for a type, arm 3 is recorded as **inconclusive at
  weight 1.0** — the weight did not reach those documents — not as "shaping fails".
- Nothing is built for a type whose verdict is constraint.

## Results

_(filled in after the runs; the rule above is frozen)_

### Determinism check (arm 1, twice)

TBD

### Per set

| set | arm | MAP | attainable recall |
|---|---|---|---|
| cite_01 | 1 no facet | TBD | TBD |
| cite_01 | 2 filter | TBD | TBD |
| cite_01 | 3 boost | TBD | TBD |
| cite_02 | 1 no facet | TBD | TBD |
| cite_02 | 2 filter | TBD | TBD |
| cite_02 | 3 boost | TBD | TBD |
| probe | 1 no facet | TBD | TBD |
| probe | 2 filter | TBD | TBD |
| probe | 3 boost | TBD | TBD |

### Per facet case

| case | arm 2 AP / aR | arm 3 AP / aR | gold removed (2) | gold boosted (3) | leakage |
|---|---|---|---|---|---|
| `q10_urban_finance_since_2020` | TBD | TBD | TBD | TBD | TBD |
| `d5_public-transport-financing-since-2022` | TBD | TBD | TBD | TBD | TBD |
| `office_q10_mexico` | TBD | TBD | TBD | TBD | TBD |
| `office_d7_india` | TBD | TBD | TBD | TBD | TBD |

### Verdicts

| type | verdict | numbers that produced it |
|---|---|---|
| recency | TBD | TBD |
| office | TBD | TBD |
| series | blocked (#523) | no document carries a series value |

## Reproduction

```bash
export EVAL_EXPANSION=off
# arm 1 — `{}` rather than unset: the unset path crashes on qa until #520 lands.
EVAL_FACETS='{}' npx tsx evaluation/run-evalset.ts evaluation/evalsets/evalset_cite_01.json
EVAL_FACETS='{}' npx tsx evaluation/run-evalset.ts evaluation/evalsets/evalset_cite_02.json
EVAL_FACETS='{}' npx tsx evaluation/run-evalset.ts evaluation/evalsets/facet-office-probe.json
# arm 2 — hard filter (FACET_MODE unset or "filter")
EVAL_FACETS='{"q10_urban_finance_since_2020":[{"facet":"year_min","value":"2020"}]}' \
  npx tsx evaluation/run-evalset.ts evaluation/evalsets/evalset_cite_01.json
EVAL_FACETS='{"d5_public-transport-financing-since-2022":[{"facet":"year_min","value":"2022"}]}' \
  npx tsx evaluation/run-evalset.ts evaluation/evalsets/evalset_cite_02.json
EVAL_FACETS='{"office_q10_mexico":[{"facet":"office","value":"WRI Mexico"}],"office_d7_india":[{"facet":"office","value":"WRI India"}]}' \
  npx tsx evaluation/run-evalset.ts evaluation/evalsets/facet-office-probe.json
# arm 3 — the same three commands with FACET_MODE=boost in the search service env
```

## Caveats

- Sidecar off in every arm: this says nothing about auto-detected or LLM-authored facets, and
  nothing about facets a user did not ask for.
- A pre-rerank boost only changes window membership. A document that neither the filter nor
  the boost surfaces is out of reach for both arms; this experiment cannot speak to it.
- Weight 1.0 = one RRF vote at rank 1. A sweep is a different experiment.
- The office probe is constructed. It measures the mechanism, not whether users ask for
  offices this way.
