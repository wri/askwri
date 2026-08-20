# Investigation brief — P2 gate FAIL: why does the alias lane regress cite recall? (v3.2)

> **For a fresh session on a more capable model.** This is a diagnostic
> investigation, NOT a tuning pass. The operator explicitly does not want
> blind retuning. Goal: explain **why** the alias lane drops cite recall
> (v3.2 flag-off 0.7424 → flag-on 0.6198, macro excl. q10; −0.1226), and
> propose the **smallest change that could make it safe to activate** —
> grounded in evidence, not guesswork.
>
> **The v3.2 golden set is the current baseline.** The first gate run
> (commit `509cae4`) used v3.1 and is superseded. This brief was updated
> after a v3.2 re-run; read it fresh, do NOT trust any v3.1 numbers from
> earlier notes. The operator halted the first investigation midstream to
> re-run on v3.2 — the investigation has NOT started.
>
> Do NOT run the gate, do NOT flip flags, do NOT push, do NOT deploy.
> Read-only investigation + a written hypothesis + a proposed experiment
> plan for the operator to approve. All work on the
> `feature/query-expansion-p2` branch at
> `/Users/gutelius/dev/askwrimvp/.claude/worktrees/feature-query-expansion-p2`
> (HEAD `8c13d70`). The P2 code is merged; the v3.2 gate doc is
> `docs/plans/2026-08-19-query-expansion-p2-gate-results.md`.

## 1. What P2 built (the thing under investigation)

P2 generalized WRI's `HybridFusionRetriever` from a fixed {dense, sparse}
lane pair to a lane list, and added a **deterministic alias-expansion lane**
sourced from the `tag_aliases` table. The design intent: replace the old
`DOMAIN_EXPANSIONS` OR-stuffing (which jammed synonyms into the original
sparse query) with a *separate* 1×-weight sparse lane carrying the
expansions, so the original query's ranking is preserved (spec §4.4
precision guard) while recall widens.

Key mechanics (all flag-gated behind `QUERY_EXPANSION_LANES_ENABLED`, which
also requires `QUERY_UNDERSTANDING_ENABLED`):

- `app/alias_expand.py` — `AliasExpander.expand(query)`: matches
  `tag_aliases` groups in the query (word-boundary, longest-match-first,
  <3-char terms skipped, caps 3 groups × 2 terms). `db_expander()` reads
  `SELECT t.value_id, a.alias FROM tag_aliases a JOIN tags t ON t.id = a.tag_id`.
- `app/understanding.py` — `build_understanding(..., expansion_lanes=True)`
  populates `u.alias_expansions` (failure-soft → `degraded`).
- `app/main.py` (line ~1115-1136) — when `lanes_active(...)`, builds ONE
  extra sparse lane:
  ```python
  alias_query = " OR ".join([request.query] + understanding.alias_expansions)
  ```
  weight 1× (resolves to `sparse_weight`), `top_k = bm25_top_k`. Passes
  `domain_expansion=not lanes_on` (= `False`) to the original sparse lane
  — **the gated `DOMAIN_EXPANSIONS` retirement**: the original sparse lane
  sees the RAW query, no OR-stuffing.
- `HybridFusionRetriever._retrieve` (main.py ~246-330) — RRF over
  `[dense, sparse, ...extras]`. **Original lanes get 2× weight ONLY when at
  least one extra lane returned results** (operator decision c). k=60.
  Extra lanes failure-soft (dropped → `degraded_lanes`).
- The reranker only ever sees the ORIGINAL query (`postprocess_nodes`'
  `query_bundle` untouched). The alias lane changes the candidate pool
  fed to RRF; RRF feeds the reranker.

The seed: `scripts/tag-aliases-seed.json` — 17 entries / 102 aliases,
mapped from `DOMAIN_EXPANSIONS` (21 groups) onto qa topic tags. Applied
to qa: 102 aliases / 17 tags, idempotent, vocab rebuilt (1410 terms).
3 unmapped groups (`children`, `bangalore`, `brazil`) — `geo` facet
deferred post-P2. **The "new aliases" are the same synonyms as the old
dictionary, just sourced from the taxonomy table. Content didn't
change — delivery did.**

## 2. The confirmed mechanism (read this first — verified from the code)

When lanes are ON, there are THREE lanes feeding RRF:

| Lane | BM25 query | Old `DOMAIN_EXPANSIONS`? | New `tag_aliases`? |
|---|---|---|---|
| **sparse** (original) | raw query only (`domain_expansion=False`) | **OFF** (retired) | no |
| **alias_sparse** (new) | `<raw query> OR <alias1> OR <alias2>...` | no (bypasses `build_sparse_query`) | **ON** |
| **dense** | embedding on raw query | — | — |

The critical detail: **the alias lane's query string includes the original
query** (`" OR ".join([request.query] + understanding.alias_expansions)`,
main.py:1116). So the original query runs in TWO sparse lanes (original +
alias), while alias-only terms run in ONE (alias lane only).

RRF contribution to a doc's fused score:
- A doc matching the **original query**: `sparse_weight × 2.0 × 1/(60+rank_s)` (original lane, 2× because an extra materialized) **+** `sparse_weight × 1.0 × 1/(60+rank_a)` (alias lane, 1×).
- A doc matching **only an alias**: `sparse_weight × 1.0 × 1/(60+rank_a)` (alias lane only).

**Net: original-query docs get double-counted across two sparse lanes;
alias-only docs get single-counted.** The 2× original-lane weight was
designed to protect golden docs, but it over-boosts ALL original-query
docs (golden and non-golden), which shifts fused ranks, which shifts the
rerank window, which drops some golden docs out of the returned top-k
(the gate measured 11 `in_window_not_returned`, zero
`displaced_by_variant_lane`).

**The v3.2 data is consistent with this hypothesis:**
- q10 (golden docs ARE original-query matches, "urban finance since 2020") — flag-on IMPROVED (+0.10). The double-counting helps when golden docs match the raw query.
- q4, q7 (golden docs need synonym matches, "climate adaptation in Brazil" / "Jakarta housing") — flag-on REGRESSED (−0.33, −0.25). The double-counting over-boosts non-golden original-query docs and pushes the synonym-dependent golden docs out.

**This is the leading hypothesis to confirm or refute.** Trace it.

## 3. The v3.2 gate result (the thing to explain)

Rig: local search-service on :8000 pointed at qa RDS via
`./scripts/with-remote-env.sh qa bash -c 'cd <worktree>/search-service &&
<mainrepo>/search-service/venv/bin/python -m app.main'` with
`RETRIEVAL_BACKEND=postgres KEYWORD_BACKEND=sparse`. Golden set:
`evaluation/golden-dataset.json` regenerated from `evalset_cite_01.json`
v3.2 (submodule `2d31b72`) via external_id→url lookup against qa
documents (67/67 found, commit `f302757`).

| Rule | v3.2 result |
|---|---|
| Step 1: local suites | PASS (leak detectors 5 passed) |
| Step 2: flag-off cite macro recall (excl q10) | **0.7424** (new baseline) |
| Step 3: flag-on cite macro recall (excl q10) | **0.6198** (−0.1226) **FAIL** |
| Step 3: answer chunk R ≥ 0.3307 | PASS (0.3327) |
| Step 3: q10 year ≥ 2020 | PASS (all 5 docs ≥ 2024) |
| Step 4: zero `displaced_by_variant_lane` | **PASS** (0) — 2× bound held at window level |

**The headline:** flag-on cite recall fell 0.7424 → 0.6198 (macro excl.
q10), a 0.1226 drop. The 2× original-weight bound held — no variant-only
node displaced a golden doc from the rerank window. So this is
**reordering, not displacement**: golden docs made the rerank window but
the reranker ranked them out of the returned top-k (11
`in_window_not_returned` cases).

**Note on the stale threshold:** the original P2 gate rule was "cite macro
recall (excl q10) ≥ 0.8583." That number was the v3.1 flag-off baseline.
v3.2 flag-off is 0.7424 — already below 0.8583 with NO P2 code in the path.
The 0.8583 threshold is dead; the operator has ruled v3.2 is the new
baseline. The right gate rule is now "flag-on may not fall below flag-off
(both v3.2)" — and flag-on (0.6198) < flag-off (0.7424), so the gate
still FAILs. Do NOT re-litigate the threshold; the investigation is about
the 0.1226 drop, not the absolute number.

## 4. The per-query evidence (the core data — v3.2)

All 11 cite queries, flag-off vs flag-on recall, alias_lane_size, and
per-lane contribution (from the attribution report). Δ = flag-on − flag-off:

| Query | flag-off R | flag-on R | Δ | alias | lane_contrib (d/s/alias) | regressed? |
|---|---|---|---|---|---|---|
| q1_land_value_capture | 0.6667 | 0.6667 | 0.0000 | 4 | 24/24/25 | flat (dissolved from v3.1's −0.25) |
| **q2_bangalore_geography** | 0.8333 | 0.5000 | **−0.3333** | **0** | 9/4/— | **known gap** (geo facet deferred; alias lane didn't fire) |
| q3_children_pollution | 0.8333 | 0.6667 | −0.1667 | 2 | 7/2/4 | yes |
| q4_climate_brazil | 0.6667 | 0.3333 | **−0.3333** | 2 | 7/4/5 | yes (worst, tied) |
| q5_micromobility | 0.5833 | 0.5833 | 0.0000 | 4 | 14/20/21 | flat |
| q6_school_bus_health | 1.0000 | 0.8571 | −0.1429 | 4 | 10/10/10 | yes |
| q7_jakarta_housing | 0.7500 | 0.5000 | **−0.2500** | 2 | 8/8/8 | yes |
| q8_hydrogen | 1.0000 | 1.0000 | 0.0000 | 2 | 10/15/14 | flat (perfect) |
| q9_world_resources_report | 1.0000 | 1.0000 | 0.0000 | 0 | 21/33/— | flat (alias didn't fire) |
| q10_urban_finance_since_2020 | 0.3000 | 0.4000 | **+0.1000** | 6 | 1/4/4 | **improved** (worst v3.1 regression, now helps) |
| q11_urban_finance_exclude_ebuses | 0.0909 | 0.0909 | 0.0000 | 6 | 8/13/14 | flat (near-floor) |

**The four regressing alias-active queries (q3, q4, q6, q7) are the real
signal.** q2 is the known geo-facet gap (alias_lane_size=0, exclude from
the "why did the alias lane hurt" question). q10 is the counterexample
(alias lane HELPED) — the key data point that distinguishes the
double-counting hypothesis (§2): q10's golden docs match the raw query, so
the double-counting helps them; q4/q7's golden docs need synonyms, so the
double-counting over-boosts non-golden original-query docs and pushes
them out.

## 5. The artifacts to read (all in the worktree, HEAD `8c13d70`)

- **Gate doc (v3.2):** `docs/plans/2026-08-19-query-expansion-p2-gate-results.md`
  — the current FAIL write-up.
- **Design spec:** `docs/plans/2026-08-19-query-expansion-design.md` — §4.1
  (deterministic tier), §4.3 (multi-lane weighted RRF + 2× rule), §4.4
  (precision guard — reranker sees original query), §5 (failure posture),
  §6 (observability — lane_contribution), §7 (P2 gates + named regression
  mechanism), §8 (testing).
- **Implementation plan:** `docs/plans/2026-08-19-query-expansion-p2-implementation.md`
  — the 8 tasks, Global Constraints, gate rules. (Note: its Task 8 numbers
  are v3.1; the v3.2 re-run superseded them. Read it for the constraints and
  the mechanism, not the numbers.)
- **The code:**
  - `search-service/app/alias_expand.py` (expander — `db_expander`,
    `AliasExpander.expand`)
  - `search-service/app/understanding.py` (`build_understanding`,
    `lanes_active`, `alias_expansions`)
  - `search-service/app/main.py` — **the alias lane construction is at
    ~line 1115-1136** (`alias_query = " OR ".join([request.query] +
    understanding.alias_expansions)`); the retriever RRF loop is ~246-330;
    the `/query` wiring ~1082-1136; debug dict ~1504; EMF ~959.
  - `search-service/app/query_expansion.py` (`build_sparse_query` /
    `sparse_query_for` with `domain_expansion` kwarg; `DOMAIN_EXPANSIONS`
    at line 19, `expand_query_conservative` at 249)
  - `search-service/app/bedrock_rerank.py` (`_select_candidates` — the
    rerank window; pure function — read it to find the actual
    `rerank_candidates` value)
  - `search-service/app/config.py` (the flags + `rerank_candidates`)
- **The seed:** `scripts/tag-aliases-seed.json` (17 entries / 102 aliases
  / 3 unmapped). `scripts/seed-tag-aliases.ts`.
- **The three v3.2 eval JSON reports (the data):**
  - Flag-off cite: `evaluation/results/eval-report-1787197542706.json`
    (overall_recall 0.7022)
  - Flag-on cite: `evaluation/results/eval-report-1787197801503.json`
    (overall_recall 0.5998)
  - Attribution: `evaluation/results/eval-report-p2-v32-attribution-1787198162339.json`
    (label p2-v32-attribution; per-result `lane_attribution` with
    `best_fused_rank`, `alias_lane_size`, `lane_contribution`)
  - Each `results[]` entry has: `test_case_id`, `question`,
    `expected_urls`, `retrieved_urls`, `matched_urls`, `false_negatives`,
    `false_positives`, `recall`, `precision`, `f1`. The attribution
    report adds `lane_attribution` (per-FN status + best_fused_rank) and
    `lane_contribution`.
- **Golden set:** `evaluation/golden-dataset.json` (regenerated from
  `evalset_cite_01.json` v3.2; the submodule is at `2d31b72`).
- **SDD ledger (full task history + rulings):**
  `.superpowers/sdd/2026-08-19-query-expansion-p2-implementation/progress.md`
  — read for the operator rulings, especially the geo-facet deferral and
  the v3.1→v3.2 re-run.

## 6. The questions to answer (in priority order)

1. **Confirm or refute the double-counting hypothesis (§2).** Trace the
   RRF math concretely for q4 (regressed, golden docs need synonyms) and
   q10 (improved, golden docs match raw query). For each, compute: what
   fused rank does each golden doc get flag-off vs flag-on? How many
   original-query docs get the double-boost, and how many rank above the
   golden doc as a result? The attribution report's
   `lane_attribution[].best_fused_rank` + `lane_contribution` is the
   instrument; `fused_nodes` (Task 5, emitted in diagnostic mode) has
   per-node per-lane ranks if you need finer detail.

2. **Is the alias lane's inclusion of the original query mandated by the
   spec, or an implementation choice?** Read design §4.3. If the spec
   says the alias lane carries "the query + expansions," it's mandated
   (a design question for the operator). If the spec says "expansions
   only," the current `" OR ".join([query] + expansions)` is a bug — the
   alias lane should be `expansions` only, which eliminates the
   double-count. **Check the spec wording exactly.**

3. **What is `rerank_candidates`, and is the rerank-window cut the real
   boundary?** The attribution classifier's `in_window_not_returned` vs
   `below_window` boundary is the rerank window. Read
   `app/config.py` `rerank_candidates` and
   `BedrockReranker._select_candidates`. Some FNs have high
   `best_fused_rank` — reconcile whether those are actually inside or
   outside the window.

4. **Is the 2× original-weight bound sufficient?** It protects window
   *slots* (zero displacement) but not fused *ranks*. The reranker window
   is cut on fused rank. Would 3× or 4× help, or does the
   double-counting (q1) dominate regardless? **Don't tune — model the
   effect** using the per-lane ranks from the attribution report for q4
   and q7.

5. **Is the cap (3 groups × 2 terms = 6 expansions) too loose?** q10
   (alias_lane_size=6) improved; q3/q4/q7 (alias_lane_size=2) regressed.
   The cap doesn't obviously predict the outcome — q10's 6 expansions
   helped, q3's 2 hurt. So the cap is probably not the lever; the
   double-counting (q1) is. Note this if the data supports it.

6. **Is the reranker the real problem, or the candidate pool?** The
   reranker sees the original query and re-scores the candidate pool.
   The alias lane widens the pool. For q4: was `prepared-communities`
   (a golden doc) in the pool flag-off and dropped flag-on, or did it
   fall out of the pool entirely (`never_retrieved`)? The `fused_nodes`
   snapshot + per-lane ranks answer this. If golden docs are
   `never_retrieved` flag-on but were retrieved flag-off, the alias lane
   *replaced* them in the pool (candidate displacement, not just
   reranker reordering) — that would be a different mechanism than
   `in_window_not_returned` suggests.

7. **Is this partly a golden-set artifact despite v3.2?** v3.2 flag-off
   (0.7424) is much lower than v3.1 flag-off (0.8583) — the new golden
   set is harder. Are the regressing queries (q4, q7) ones where v3.2
   added expected docs that are synonym-dependent? (v3.2 added
   `bridging-national-and-local-climate-adaptation-in-brazil-india-and-indonesia`
   to q4 — was that retrieved flag-on?) Check whether the v3.2
   expected-doc additions changed the per-query flag-off baseline in a
   way that interacts with the alias lane.

## 7. What to produce (the deliverable)

A written analysis at
`docs/plans/2026-08-19-query-expansion-p2-investigation.md`:

1. **Confirmed root cause** for the cite recall regression, with the
   RRF/rerank math traced for q4 (regressed) and q10 (improved). Cite
   fused ranks and lane contributions from the v3.2 attribution report.
   State whether the double-counting hypothesis (§2) is confirmed or
   refuted.
2. **Spec check** on whether the alias lane must include the original
   query (question 2) — quote the exact spec wording from
   `docs/plans/2026-08-19-query-expansion-design.md` §4.3.
3. **`rerank_candidates` reconciliation** (question 3).
4. **A ranked list of candidate fixes**, smallest-first, each with:
   - what it changes
   - the hypothesis for why it helps (grounded in the trace)
   - what it might break
   - whether it's a P2-scope change (e.g., drop the query from the alias
     lane; retune the 2× weight; tighten the cap) or a post-P2 design
     change (e.g., a geo facet; changing the rerank window logic)
5. **An experiment plan** the operator can approve: which fix to try
   first, what the gate re-run would look like, what success looks like.
   Do NOT run it — propose it.
6. **Explicit non-goals:** do not retune blindly; do not flip flags; do
   not push; do not deploy; do not modify the v3.2 golden set or P0
   baselines.

## 8. Constraints that still govern (from the P2 plan Global Constraints)

- Flag off must be byte-identical. P2-on/P1-off must reproduce P1 exactly.
- The reranker only ever sees the original query (§4.4) — any fix that
  touches `postprocess_nodes`' `query_bundle` is out of scope.
- No retry loops; failure-soft; no 500s.
- `QueryRequest`/`QueryResponse` fields additive only; `debug` is
  `Dict[str, Any]`.
- No new Python deps.
- The 2×-only-when-materialized rule (operator decision c) is encoded in
  the retriever; a degraded alias lane falls back to unscaled weights.
- `tag_aliases` is app-owned; Python only reads it.
- Commit style: conventional commits, explicit `git add`, no
  Co-Authored-By.
- No production deploy. No flag flip in any deployed environment. Do not
  push or open a PR without asking the operator.
- Both flags (`QUERY_UNDERSTANDING_ENABLED`,
  `QUERY_EXPANSION_LANES_ENABLED`) stay OFF everywhere deployed.

## 9. Rig (if the operator approves a re-run — do NOT run unprompted)

- Service: `./scripts/with-remote-env.sh qa bash -c 'export
  RETRIEVAL_BACKEND=postgres KEYWORD_BACKEND=sparse && cd
  <worktree>/search-service && <mainrepo>/search-service/venv/bin/python
  -m app.main'` (add `export QUERY_UNDERSTANDING_ENABLED=true && export
  QUERY_EXPANSION_LANES_ENABLED=true &&` for flag-on). Needs `aws login
  --region us-east-2`.
- Evals hit `http://127.0.0.1:8000`: `npm run eval:cite`,
  `npm run eval:answer-retrieval`. Attribution:
  `EVAL_LANE_ATTRIBUTION=1 EVAL_LABEL=<distinct> npm run eval:cite`.
- Local docker `askwri-pg` has only 19 tags (not qa's 775) — local
  apply of the seed is a false-positive; qa is the only meaningful rig.

## 10. SDD state (for continuity)

Tasks 1-7 complete and reviewed clean (commits `5752707`→`183a842`).
Task 8 ran twice (v3.1 `509cae4` FAIL, v3.2 `8c13d70` FAIL). The v3.2
re-run is canonical. The SDD ledger is at
`.superpowers/sdd/2026-08-19-query-expansion-p2-implementation/progress.md`
— read it for the full task-by-task history and the operator rulings.

**Operator rulings to carry (do NOT re-litigate):**
- The geo facet is deferred post-P2. q2 (`bangalore`, alias_lane_size=0)
  is a known gap, not a gate-fail contributor.
- v3.2 is the current baseline. The 0.8583 threshold is dead (it was the
  v3.1 flag-off baseline; v3.2 flag-off is 0.7424). The gate rule is now
  "flag-on may not fall below flag-off (both v3.2)."
- The investigation was halted midstream on v3.1 to re-run on v3.2. It
  has NOT started. Do not trust v3.1 numbers from any earlier notes.
