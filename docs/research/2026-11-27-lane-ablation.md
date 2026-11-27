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
