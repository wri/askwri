# Query-expansion lane ablation, and the parser-vs-lanes experiment it motivates

**Date:** 2026-11-27
**Status:** part 1 measured (local diagnostic); part 2 **pre-registered, not yet run**
**Context:** cite_01 regresses on the default (flags-on) arm: 38.0 MAP vs 39.6 on the
no-facet arm, and the 2026-11-24 promotion memo returned HOLD (cite_01 −2.0 pp,
p95 +1.39 s). This diagnostic asks *which part* of the flags-on bundle costs the points.
Refs #498 (items 8, 9), #450, #522, #529.

## Rig (part 1)

Local search-service at `qa` tip (`655d045`), qa RDS via `scripts/with-remote-env.sh`,
Bedrock embed/rerank, `RETRIEVAL_BACKEND=postgres`, `KEYWORD_BACKEND=sparse`. The same
service flags were flipped per arm; requests replicated the cite preset
(`vector_top_k=500, bm25_top_k=500, rerank_top_n=500, fusion_top_k=500, max_results=25`)
and were scored doc-grain AP against the fixture's expected ids on the six weakest cite_01
cases. Not the official harness: it measures `/query` directly, not the gateway.

The off arm reproduces the CI gate arm exactly on gold counts (`q1` 4/5, `q3` 6/8,
`q7` 2/4, `q9` 16/16, `q10` 2/10, `q11` 2/11), so the rig is sound for relative comparison.

**Rig caveat that matters:** with `expansion: false`, `lanes_on` is false, so
`domain_expansion = not lanes_on` is **true**. The no-facet arm is not raw-query — it runs
the hand-built `DOMAIN_EXPANSIONS` dictionary. Turning lanes on retires that dictionary
(design §4.3). This substitution is the subject of the measurement.

## Arms (part 1)

| arm | understanding | lanes | sidecar | dictionary | parser |
|---|---|---|---|---|---|
| off | off | off | off | **on** | off |
| det | on | off | off | on | on |
| sidecar | on | off | on* | on | on |
| lanes | on | on | off | **off** | on |
| lanes + window 200 | on | on | off | off | on |
| lanes + cap 20/40 | on | on | off | off | on |
| lanes + weight 0.25/0.5 | on | on | off | off | on |
| off + window 200 | off | off | off | on | off |

\* the local sidecar degraded (6 OpenAI failures, `degraded: ['understanding_llm']`), so
the sidecar arm is **not** a variant-lane measurement and reads identically to `det`.
`RERANK_CANDIDATES` (the fixed pre-rerank window, `config.py:231`) is 100 by default.

## Per-case doc AP (%)

| case | off | det | lanes | lanes + win200 | lanes + cap20 | lanes + w0.25 | off + win200 |
|---|---|---|---|---|---|---|---|
| q1_land_value_capture | 32.1 | 32.1 | 17.1 | **31.9** | 17.1 | 17.1 | 32.1 |
| q3_children_pollution | 55.7 | 55.7 | 44.0 | 47.3 | 44.0 | 44.0 | 54.0 |
| q7_jakarta_housing | 10.4 | 10.4 | 4.2 | 4.2 | 4.2 | 4.2 | 10.4 |
| q9_world_resources_report | 71.6 | 71.6 | 71.6 | 73.7 | 71.6 | 71.6 | 73.7 |
| q10_urban_finance_since_2020 | 3.4 | **17.5** | 8.3 | 16.4 | 8.3 | 8.3 | 3.1 |
| q11_urban_finance_exclude_ebuses | 11.7 | 11.7 | 1.3 | 3.0 | 1.3 | 3.6 | 11.7 |
| **mean** | 30.8 | **33.2** | 24.4 | 29.4 | 24.4 | 24.9 | 30.8 |

Gold counts move only on `q10` (`det` 3/10, `lanes` 1/10, `lanes + win200` 4/10,
`off + win200` 2/10) and `q11` (`off`/`det` 2/11, `lanes` 1/11).

## Findings

1. **The deterministic parser is the only measured win.** `det` is +2.4 mean AP, entirely
   `q10` (+14.1): the parsed `year_min=2020` is applied hard and no other case moves.
2. **Lanes cost more than they add, because they retire the dictionary.** `lanes` is
   −6.4 mean AP against `off`: `q1` −15.0, `q3` −11.7, `q7` −6.2, `q11` −10.4. It also
   erases `q10`'s parser gain (17.5 → 8.3).
3. **Not a lane-doc crowding of the window.** Capping lane documents (20 or 40) changes
   nothing — the lanes were never contributing many documents — and lowering the lane
   weight to 0.25 recovers at most `q10` +5 and `q11` +2.3.
4. **Raising the rerank window only compensates for lanes.** 200 candidates recovers most
   of the lane regression (24.4 → 29.4, still below `off` 30.8) while leaving the off arm
   flat (30.8 → 30.8). It doubles rerank spend and adds seconds; it is a workaround, not a
   win.
5. **Interpretation limit.** `DOMAIN_EXPANSIONS` mirrors evalset topics (already flagged in
   #498 item 12: "urban finance", "electric buses", "micromobility"). The `off`/`det`
   advantage may therefore be eval-specific. The parser gain does **not** depend on the
   dictionary and is the generalizable part. Sidecar variants remain unmeasured here.

## Part 2 — pre-registered QA experiment (do not edit the decision rule after the first run)

**Hypothesis.** The flags-on bundle is worth less than its parts: enabling the
deterministic understanding tier while leaving lanes and the sidecar off (`A1`) beats the
current all-on configuration (`A0`) on cite_01 without losing cite_02, the no-facet gate,
or latency.

| arm | `QUERY_UNDERSTANDING_ENABLED` | `QUERY_EXPANSION_LANES_ENABLED` | `QUERY_UNDERSTANDING_LLM_ENABLED` |
|---|---|---|---|
| A0 current qa | true | true | true |
| A1 parser only | **true** | **false** | **false** |
| A2 parser + sidecar (conditional on A1) | true | false | true |
| A3 no-facet control | request `expansion:false` | — | — |

A1 keeps `DOMAIN_EXPANSIONS` (lanes off ⇒ dictionary on) and adds parsed facets. No code
change: `terraform/environments/qa.tfvars` only. Each arm is its own deploy; the live
search-service image tag and env are asserted from the task definition, not inferred from a
green workflow.

**Runs.** Each arm: cite_01 and cite_02 with the default arm (no request params), twice;
plus the A3 gate pass in the same run. Arms do not share a deploy. Report JSONs record
`expansion_arm`; A1 repeats must be identical (sidecar off), so any spread voids the arm.

**Metrics.** cite_01/cite_02 doc MAP and attainable recall; the no-facet gate
(`no-facet-gate.json`, ±1 pp); positives falsely flagged off-topic; p50/p95; cost.

**Decision rule (pre-registered).** A1 replaces A0 only if **all** hold:

1. cite_01 default-arm MAP is higher than A0 by **more than 1.0 pp** (the gate tolerance);
2. cite_02 default-arm MAP is **not lower** than A0 by more than 1.0 pp;
3. the no-facet gate still passes for both sets;
4. service p95 is **not higher** than A0.

A tie, or a gain bought with cite_02, p95, or the gate, is a hold — record it and stop.
A2 is run only if A1 passes, and answers the untested variant question on the same terms
(decision rule applied against A1).

**What this cannot settle.** Whether the dictionary's advantage generalizes beyond the
evalsets (finding 5). That needs fresh queries, not more arms on these 24 cases.

## Part 3 — Results (run 2026-11-27, qa)

A0 was measured on image `1eb671a186bf110d9aa9a6a0bfc8e9ddd4a0446c`, env
`QUERY_UNDERSTANDING_ENABLED=true`, `QUERY_EXPANSION_LANES_ENABLED=true`,
`QUERY_UNDERSTANDING_LLM_ENABLED=true`. A1 was measured after #531 merged, on image
`4d590f04b4839d9dbe5e0123d085f8f147e0dd81`, env unchanged except both the lanes and
sidecar flags `false`. Both asserted from the live task definition, not from the workflow.

| metric | A0 all-on | A1 parser only | delta |
|---|---|---|---|
| cite_01 MAP / aR | 38.0 / 67.3 | **40.8 / 68.7** | +2.8 / +1.4 |
| cite_02 MAP / aR | **77.2 / 88.0** | 74.7 / 86.9 | −2.5 / −1.1 |
| gate cite_01 / cite_02 | 39.6/67.8, 73.7/86.9 PASS | same, PASS | — |
| wall p50 / p95 (cite_01) | 2.5 / 3.0–3.7 s | **1.4 / 1.6–2.0 s** | ≈ −1.1 / −1.4 s |
| wall p50 / p95 (cite_02) | 2.5 / 3.0 s | **1.4 / 1.6 s** | ≈ −1.1 / −1.4 s |
| cite_02 negatives | 2/3 abstained | **0/3 abstained** (19–23 docs returned, none flagged) | −2 |
| cost | $0.0020/query both | $0.0020/query both | — |

Both repeats of every cell were identical. Per-case movement:

- cite_01 gains: `q1` 18→32, `q3` 45→56, `q9` 64→72, `q10` 3→18, `q11` 11→12; loses
  `q2` 50→45, `q4` 71→62, `q5` 41→38. This reproduces the local diagnostic.
- cite_02 loses: `d1` 67→55, `d4` 71→59, `d12` 58→48, `d14` 83→64; gains `d2`, `d7`,
  `d13`. With the sidecar off, `likely_off_topic` is hard-wired false, so the negative
  cases can no longer abstain by flag.

### Verdict: HOLD — A1 does not replace A0

The pre-registered rule fails on criterion 2 (cite_02 −2.5 pp against a 1.0 pp
tolerance). It passes criteria 1 (+2.8 on cite_01) and 4 (p95 lower), and the gate
passes. **A1 is MAP-neutral across the two sets (+2.8 vs −2.5) and roughly halve the
latency, but it loses the cite_02 cases and the off-topic abstentions.** A2 (parser +
sidecar, lanes off) was conditional on A1 passing and was therefore not run. qa is
restored to A0.

### What the run exposed

- The rule omitted **negative abstentions**, which the A1 run moved 2/3 → 0/3. Any future
  arm must score them explicitly; MAP alone hides a product regression ("nothing
  relevant" never fires).
- The local diagnostic translated to QA: the flags-on bundle really is a trade between
  cite_01's dictionary/topic cases and cite_02's variant-dependent cases, not a uniform
  gain. Neither configuration dominates.
- The open question is now attribution within the bundle: lanes vs sidecar. If pursued,
  pre-register A2 (parser + sidecar, lanes off) with the abstention count as a metric,
  and the same gate/p95 bars.

## Part 4 — A2 pre-registration: lanes off, sidecar on

**Written before the A2 deploy; the decision rule is frozen here.** A1 could not say whether the
cite_02 loss came from turning the lanes off or from turning the sidecar off. A2 keeps the
sidecar and the dictionary (lanes off ⇒ `domain_expansion` on), so it isolates the lanes.

**Hypothesis.** The lanes are the whole trade: A2 keeps A1's cite_01 gain while recovering
cite_02's cases and its off-topic abstentions.

| arm | understanding | lanes | sidecar | dictionary | reference |
|---|---|---|---|---|---|
| A0 | on | on | on | off | measured 2026-11-27, image `1eb671a` |
| A1 | on | off | off | on | measured 2026-11-27, image `4d590f0` |
| **A2** | on | **off** | **on** | on | this arm |

Configuration is `terraform/environments/qa.tfvars` only; no code. Env asserted from the live
task definition after deploy, not from the workflow.

**Runs.** cite_01 and cite_02 with the default arm, twice each, plus the A3 no-facet gate pass
in the same run. The two A2 repeats must be identical (the sidecar is `lru_cache`d per process);
a spread > 1 pp voids the arm.

**Metrics.** cite_01/cite_02 doc MAP and attainable recall; gate (`no-facet-gate.json`, ±1 pp);
cite_02 negatives abstained (A0 = 2/3); positives falsely flagged (A0 = 1 on cite_01, 0 on
cite_02); wall p95; cost.

**Decision rule (pre-registered).** A2 replaces A0 only if **all** hold:

1. cite_01 default MAP ≥ A0 + 1.0 pp (**≥ 39.0**);
2. cite_02 default MAP ≥ A0 − 1.0 pp (**≥ 76.2**);
3. the no-facet gate passes for both sets;
4. cite_02 negatives abstained **≥ 2/3**;
5. positives falsely flagged **≤ 1** across both sets;
6. wall p95 no higher than A0 on either set (cite_01 **≤ 3.7 s**, cite_02 **≤ 3.0 s**).

A tie on any criterion is a HOLD. If A2 fails criterion 2, the lanes are not the cite_02 factor
and the remaining explanation is the sidecar — the bundle is then a genuine two-way trade with
no configuration that dominates on this eval.

**What it cannot settle.** Whether any of this generalizes beyond these 24 cases, or whether
`DOMAIN_EXPANSIONS`' advantage is the eval mirroring its own topics (#498 item 12). Unchanged.

## Part 5 — A2 results

A2 deployed as image `2f03b8822af9b599c85e479b8932d3eff9778442` with lanes `false`, sidecar
`true`; env asserted from the live task definition.

| metric | A0 all-on | A1 lanes+sidecar off | A2 lanes off, sidecar on | rule |
|---|---|---|---|---|
| cite_01 MAP / aR | 38.0 / 67.3 | 40.8 / 68.7 | 40.8 / 68.7 | ≥ 39.0 PASS |
| cite_02 MAP / aR | 77.2 / 88.0 | 74.7 / 86.9 | 74.7 / 86.9 | ≥ 76.2 **FAIL** |
| gate | pass | pass | pass | PASS |
| cite_02 negatives | 2/3 | 0/3 | **2/3** | ≥ 2/3 PASS |
| false positives | 1 (cite_01) | 0 | 1 (cite_01) | ≤ 1 PASS |
| p95 cite_01 / cite_02 | 3.0 / 3.0 s | 1.6 / 1.6 s | 2.3–3.7 / 2.0–6.1 s | ≤ 3.7 / ≤ 3.0 **ambiguous** |

Both repeats identical on MAP and aR. The p95 spread in A2 is real: the first repeat runs the
sidecar cold (cite_02 p95 6.1 s), the second is warm (2.0 s); neither repeat may be cherry-picked.

**A2's positive-case scores are byte-identical to A1's, case for case.** The sidecar changes
`likely_off_topic` and latency, and nothing else: every d8/d9 negative abstains again, and no
positive MAP moves. So the cite_01/cite_02 trade is **entirely lanes vs `DOMAIN_EXPANSIONS`**,
not lanes vs sidecar.

### Verdict: HOLD — A2 does not replace A0

Criterion 2 fails by the same −2.5 pp as A1. qa is restored to A0.

### Where that leaves the expansion bundle

The trade is now fully attributed and it does not have a dominant configuration on this eval:

| configuration | cite_01 | cite_02 | abstentions | p95 |
|---|---|---|---|---|
| lanes on (dictionary retired) | 38.0 | **77.2** | 2/3 | 3.0 |
| lanes off (dictionary on) | **40.8** | 74.7 | 2/3 (sidecar on) | 2.0–6.1 |

The sum is flat (115.2 vs 115.5 MAP) and the choice is a product weighting, not a tuning
problem. The sidecar earns its latency only through abstention. Further knob work on this
bundle — lane weight, lane caps, rerank window, window 200 — was measured as a no-op or a
workaround (Parts 1, 3, 5). The only remaining honest lever is outside the bundle: document-
level recall on broad topics (the unretrieved-gold cases q1/q3/q7/q11), and the generalization
question (#498 item 12) that these 24 cases cannot answer.
