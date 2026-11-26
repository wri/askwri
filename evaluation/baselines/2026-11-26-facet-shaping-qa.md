# Facet shaping vs filtering — QA baseline (#522)

**Status:** PRE-REGISTERED — written and committed before any run. The numbers below
are filled in afterwards; the decision rule is not. Two pre-run amendments are in the
history, both before the first call: the harness now persists `facet_mode` and
`boosted_doc_ids` (so the arm can be verified rather than assumed), and the structural
caveat below records that no facet case's gold can be removed by its own filter.
**Issue:** [wri/askwri#522](https://github.com/wri/askwri/issues/522) (parent #450)
**Target:** `https://qa.askwri-app.org`, QA deploy of `fix/522-facet-shaping`
**Fixtures:** `evalset_cite_01.json` v3.2 (11 cases), `evalset_cite_02.json` v4.3 (16 cases),
and `evaluation/evalsets/facet-office-probe.json` v1.0 (2 cases, constructed here)
**Arm:** all arms `EVAL_EXPANSION=off` — deterministic path, no parser, no sidecar, no lanes.
The arm is chosen by **service env** (`FACET_MODE`), not by the request: the request bodies
are identical across arms 2 and 3. `debug.facet_mode` in each report JSON is the evidence of
which arm actually answered.

**Target build (amended before arm 3):** the measurement runs against **one combined build** —
this branch plus #525 (444 item 3, one year filter). #525 changes the year filter itself
(`year_int` source, pre-rerank only, intersecting bounds), which is exactly the mechanism the
*recency* arm measures; measuring recency on the old year path would make its verdict stale
the moment 444 shipped. The arms 1-2 numbers recorded below were taken on `858bbca`, the
pre-#525 year filter; they are kept as a stepping stone and **superseded by a re-run on the
combined build** (same commands, same rule).

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
`boosted_doc_ids ∩ returned`. Both `facet_mode` and `boosted_doc_ids` are persisted per case
in the report JSON — the harness mirrors `excluded_doc_ids` (`evaluation/lib/facet-signals.ts`,
commit `d054405`, landed **before** the first run). Counts are reported next to every
percentage: the office probe's gold is 3 and 4 documents, where one document is ~25-33
recall points.

**Every run's report JSON must show `facet_mode` matching its intended arm before any number
is read from it.** The arm comes from service env, so a report is attributable only through
that field; an arm that disagrees with its label is void, not an anomaly to explain.

**What arm 3 is, and is not.** The boost applies pre-rerank, so it changes which documents
enter the 100-candidate rerank window — **pool admission**. It is not a ranking lever and is
not reported as one.

**Tolerance: zero MAP, zero aR. Measured, not assumed.** Arms 1 and 2 were each run twice per
set against the same target: cite_01 39.6 / 67.8 twice and 40.8 / 68.7 twice; cite_02
73.7 / 86.9 twice and 74.7 / 86.9 twice; probe 57.5 / 83.3 and 58.3 / 83.3 twice. Every
repeat was identical, which is the basis for the zero tolerance. Two caveats that belong with
that claim: the 2026-11-24 zero spread this originally cited was caused by the sidecar's
`@lru_cache` replaying one draw, not by retrieval being re-measured
(`2026-11-24-flag-on-vs-off-qa.md:53-56`) — these runs measure the path with the sidecar
**off**, so the repeats are real retrievals; and arm 3 gets the same repeat treatment before
any delta from it is believed. A run whose repeat differs is void, and the spread is recorded
in place of a verdict.

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

### Structural caveat: no facet case here can lose gold to the filter

Checked against QA RDS on 2026-11-26, before any run: **every document in all four facet
cases satisfies its facet** — `q10`'s gold spans 2020-2024 (1/1/2/3/3 per year) against
`year_min` 2020, `d5`'s spans 2022-2024 (1/1/3) against `year_min` 2022, and both office
probe cases are gold ∩ office by construction.

So the filter arm cannot remove gold in this experiment, and the comparison measures what the
filter *does* to the candidate pool — freeing rerank-window slots — against what the boost
does to it, promoting gold. That is the mechanism question #522 asks, and it is the honest
limit of the answer:

- A **constraint** verdict here means the boost did not beat the filter under a **correct**
  constraint. It does **not** mean shaping loses on a dirty or loose facet value (a wrong
  office, a year the user meant approximately), which is the case where a filter removes the
  gold a boost would have kept. That failure mode is not touched by these numbers.
- Gold limits: recency has 10 and 5 gold; the office probe has 3 and 4. Read counts, not
  percentages alone.

## Results

_(numbers filled in as arms run; the rule above is frozen)_

**Arms 1 and 2 were measured on QA at `858bbca`, before this branch merged.** That is sound
rather than convenient: both arms run the filter path, which this branch leaves
behaviour-identical by default (`FACET_MODE` unset). Two cross-checks. First, the numbers match
`evaluation/baselines/2026-11-26-facet-negation-qa.md` (in tree since #520 merged: 39.6 / 67.8
and 73.7 / 86.9 for its two off-arms). The older in-repo 2026-11-24 report shows 36.4 / 65.8
for cite_01's off arm, and the gap is the build, not the harness: that arm ran before #519
landed, so it measured a different target. Second — and independently — the determinism
evidence is this branch's own paired runs (§ below), not any other file. The same runs also
prove the arm evidence is honest — `facet_mode` is `null` on that deploy, because only this
branch reports it. Arm 3 needs the deploy (`FACET_MODE=boost`), and records the image tag the
deploy landed on.

Run order, so that a determinism claim means what it says: arms 1 and 2, each run twice, on
one deployment (above); then arm 3, twice per set, on the `FACET_MODE=boost` deployment. No
arm's repeat may straddle a deploy.

### Determinism check (arm 1, twice)

| set | run A MAP / aR | run B MAP / aR | spread |
|---|---|---|---|
| cite_01 | 39.6 / 67.8 | 39.6 / 67.8 | 0 / 0 |
| cite_02 | 73.7 / 86.9 | 73.7 / 86.9 | 0 / 0 |
| probe | 57.5 / 83.3 | 57.5 / 83.3 | 0 / 0 |

### Determinism check (arm 2, twice)

| set | run A MAP / aR | run B MAP / aR | spread |
|---|---|---|---|
| cite_01 | 40.8 / 68.7 | 40.8 / 68.7 | 0 / 0 |
| cite_02 | 74.7 / 86.9 | 74.7 / 86.9 | 0 / 0 |
| probe | 58.3 / 83.3 | 58.3 / 83.3 | 0 / 0 |

Zero in both measured arms, so the pre-registered zero tolerance stands and every later delta
is attributable. Arm 3's repeats are pending its deploy.

### Per set

| set | arm | MAP | attainable recall |
|---|---|---|---|
| cite_01 | 1 no facet | 39.6 | 67.8 |
| cite_01 | 2 filter | **40.8** | **68.7** |
| cite_01 | 3 boost | TBD | TBD |
| cite_02 | 1 no facet | 73.7 | 86.9 |
| cite_02 | 2 filter | **74.7** | 86.9 |
| cite_02 | 3 boost | TBD | TBD |
| probe | 1 no facet | 57.5 | 83.3 |
| probe | 2 filter | **58.3** | 83.3 |
| probe | 3 boost | TBD | TBD |

Arm 2 moves the set only through the facet case (the other cases receive no facet): cite_01's
+1.2 MAP / +0.9 aR is `q10` alone; cite_02's +1.0 MAP is `d5` alone; the probe is nothing but
its two cases.

### Per facet case

| case | arm 1 AP / aR | arm 2 AP / aR | gold removed (2) | gold boosted (3) | leakage |
|---|---|---|---|---|---|
| `q10_urban_finance_since_2020` | 3.4 / 20.0 | 17.5 / 30.0 | 0 | TBD | 0 |
| `d5_public-transport-financing-since-2022` | 66.2 / 80.0 | 80.0 / 80.0 | 0 | TBD | 0 |
| `office_q10_mexico` | 15.0 / 66.7 | 16.7 / 66.7 | 0 | TBD | 0 |
| `office_d7_india` | 100 / 100 | 100 / 100 | 0 | TBD | 0 |

**Gold removed is zero in every case, on every arm**, which is what the structural caveat
predicted before the first run: all four facet cases have gold that satisfies its own facet.
A `constraint` verdict here therefore cannot be read as "the filter is safe"; it can only be
read as "the boost did not beat a correct filter on window composition".

Note the direction of the recency evidence: the year filter **helps** (q10 3.4 → 17.5 AP,
d5 66.2 → 80.0 AP, recall equal or better, no gold lost). The `date_constrained` group is the
only one that moves in either set.

### Verdicts

| type | verdict | numbers that produced it |
|---|---|---|
| recency | TBD (arm 3 pending) | arm 2: q10 17.5/30.0, d5 80.0/80.0, zero gold removed |
| office | TBD (arm 3 pending) | arm 2: probe 58.3/83.3, both cases unchanged or +1.7 AP |
| series | blocked (#523) | no document carries a series value |

## Reproduction

```bash
export EVAL_EXPANSION=off
# arm 1 — no facets. (Unset `EVAL_FACETS` works since #520 landed; `{}` is equivalent and was
# the workaround before that.)
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
  the boost surfaces is out of reach for both arms; this experiment cannot speak to it. More
  precisely: a boost reorders nodes **already in the fused pool** (`fusion_top_k`, 500 in cite
  mode), so a gold document outside that pool can never be admitted by a boost. In answer mode
  the pool and the rerank window are both 100, so there is almost nothing for a boost to admit.
  A zero-admission boost result can therefore be structural, which is why the rule below
  separates "weight too weak" from "nothing to admit".
- The structural caveat above: no facet case's gold can be removed by its own filter, so the
  numbers speak to window composition under a correct constraint, not to dirty-input safety.
- Weight 1.0 = one RRF vote at rank 1. A sweep is a different experiment.
- The office probe is constructed. It measures the mechanism, not whether users ask for
  offices this way.

## Amendments to the pre-registration

The rule above is unchanged from its first commit (`be15236`). Anything that had to change is
recorded here with the run state at the time, so the rule's fixity is auditable.

| date | run state | amendment | affects thresholds? |
|---|---|---|---|
| 2026-11-26 | arms 1-2 measured on `858bbca`; arm 3 not run | **Office set scope.** The frozen rule says "both sets of that type"; office has one set (the probe, two cases). "Both sets" means *every set that type runs on*: cite_01 + cite_02 for recency, the probe alone for office. A one-set verdict is recorded as a candidate for shaping, never as a mode change. | No |
| 2026-11-26 | arms 1-2 measured on `858bbca`; arm 3 not run | **Target build.** #525 (444 item 3, one year filter) merged into this branch: recency is re-measured on the combined build, because #525 changes the year filter itself. The arms 1-2 numbers already in this document stay as the pre-#525 stepping stone. | No |
