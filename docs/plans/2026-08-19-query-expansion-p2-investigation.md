# P2 alias-lane investigation — root cause of the v3.2 cite recall regression

Status: investigation complete, read-only. No gate run, no flag flips, no
push, no deploy. Baseline: **v3.2** (flag-off macro excl. q10 = 0.7424,
flag-on = 0.6198, Δ = −0.1226). All numbers below are from the three v3.2
reports (`eval-report-1787197542706.json` flag-off,
`eval-report-1787197801503.json` flag-on,
`eval-report-p2-v32-attribution-1787198162339.json` attribution) unless
marked as a code-derived constant.

## 1. Verdict on the leading hypothesis

The double-counting hypothesis (brief §2) is **confirmed — but it is one of
three compounding mechanisms, and the brief's premise that "content didn't
change — delivery did" is false.** The alias lane also changed WHICH
expansion terms run (M2 below), and a window/floor mechanism (M3) is what
converts fused-rank reordering into hard recall loss. All three follow from
code that was read and, where deterministic, executed offline; the fix
ranking in §6 targets them in size order.

**M1 — structural double-count (the brief's hypothesis, confirmed).**
`main.py:1116` builds the alias lane as
`" OR ".join([request.query] + understanding.alias_expansions)`, so the
original query runs in TWO sparse lanes. With the alias lane materialized,
weights are dense 1.0 (2×0.5), raw sparse 1.0 (2×0.5), alias 0.5 (1×0.5),
k=60. A doc matching the query literally earns
`1.0/(60+r_s) + 0.5/(60+r_a)` of sparse RRF mass; a doc reachable only
through expansion vocabulary earns at most `0.5/(60+r_a)`. Flag-off, both
doc classes competed at parity inside ONE stuffed BM25 ranking at weight
0.5. Flag-on the relative sparse mass of literal-vs-synonym matches goes
from ~1:1 to ~3:1.

**M2 — expansion vocabulary drift (new finding).** The brief's §1 claims
the aliases are "the same synonyms as the old dictionary." They are stored
the same, but they are not *selected* the same.
`AliasExpander.expand` (alias_expand.py:50-53) picks
`sorted(terms, key=str.lower)[:max_terms]` — **alphabetical** — where the
retired `expand_query_conservative` took `DOMAIN_EXPANSIONS[phrase][:2]` —
**curated order**. It also injects the tag *label* as a candidate term and
excludes only the single matched term. Verified by running both pure
functions offline against `scripts/tag-aliases-seed.json` and the exact
eval query strings (question + task, as run-cite-eval.ts sends them):

| Query | flag-off stuffing (curated) | flag-on alias lane (alphabetical) | lost |
|---|---|---|---|
| q3 | air quality, emissions, kids, students | air pollution, air quality | **emissions, kids, students** |
| q4 | climate change, emissions, brazilian, brasil | carbon, Climate Change | **emissions, brazilian, brasil** |
| q6 | kids, students, public health, health impacts, bus, transit | Health, health impacts, brt, bus | **kids, students, public health, transit** |
| q7 | affordable housing, informal settlements | affordable housing, Housing | **informal settlements** |
| q10/q11 | e-buses, electric transit, transit financing, infrastructure funding, financing, funding | battery buses, e-buses, infrastructure funding, mobility financing, costs, economic | **financing, funding, transit financing** (gained "costs", "economic" — alphabetical junk) |

Every regressing query lost curated vocabulary; part of the loss is the
deferred unmapped groups (children/bangalore/brazil — the accepted q2 gap,
but it also hits q3, q4, q6), and part is the alphabetical selection,
which is a pure implementation artifact.

**M3 — the conversion mechanism: per-doc cap + per-chunk floor.** Why does
fused reordering become *recall loss* when nothing was displaced from the
window? Because in this eval, the floor is the only cut between window and
returned set, and the floor is applied per-chunk to a doc representation
the fused order chooses:

- `rerank_candidates = 100` (config.py:191); the cite reranker has
  `per_doc_cap = 2`, and `_select_candidates` (bedrock_rerank.py:73-90)
  fills 100 slots **in fused order, at most 2 chunks per doc**, backfilling
  skipped chunks only if slots remain.
- The eval requests `rerank_top_n = 500` ≥ the 100 candidates and
  `max_results = 100` ≥ the ≤100 returned docs, so neither ever cuts. A
  windowed doc is returned iff its best windowed chunk's rerank score
  ≥ `cite_logit_floor = 0.09` (main.py:1330-1334).
- The cross-encoder scores each (original query, chunk) pair independently
  of the pool, so the same chunk scores the same in both runs (small
  run-to-run jitter noted in prior gate runs aside). Therefore
  `in_window_not_returned` for a doc that was returned flag-off means the
  fused reshuffle changed **which two chunks represent the doc** in the
  window — the above-floor chunk was capped out by two now-higher-fused
  siblings, and the substitutes score < 0.09.

The observed returned-count collapse is this mechanism operating on the
whole pool, not just goldens: q4 returned 13 docs flag-off → 7 flag-on;
q10 15 → 5. The window fills with raw/alias-boosted docs and chunk
selections that the reranker (which still sees only the original query,
§4.4) scores below the floor.

## 2. RRF trace — q4 (regressed −0.333) and q10 (improved +0.100)

Constants: k=60; flag-off weights 0.5/0.5; flag-on 1.0 (dense), 1.0 (raw
sparse), 0.5 (alias). Dense lane input is identical in both runs — every
fused movement is sparse-side.

### q4 "What have we published on climate adaptation in Brazil?"

Lane queries (offline-verified): flag-off sparse = query OR climate change
OR emissions OR brazilian OR brasil. Flag-on raw sparse = bare query; alias
lane = query OR carbon OR Climate Change. alias_lane_size=2;
lane_contribution d/s/alias = 7/4/5.

- **`prepared-communities`** (below_window, best_fused_rank **500** — dead
  last at the fusion_top_k cut; returned flag-off). The doc is a
  US/global urban-resilience framework with no literal "Brazil"; flag-off
  it rode the stuffed lane's synonym bridge in the single 0.5-weight
  sparse ranking. Flag-on its sparse support is at most the 0.5-weight
  alias lane, while every literal "Brazil"-matching doc collects
  `1.0/(60+r_s) + 0.5/(60+r_a)` — the double-dip. Its fused score fell
  below every dual-counted literal matcher: rank 500 of 500. The flag-on
  false positives that outrank it are exactly that doc class:
  `bridging-…-climate-adaptation-in-brazil-india-and-indonesia`,
  `wri_brasil-root_causes_2024_disaster_rs`,
  `technical-note-city-climate-hazards-warming-scenarios`,
  `multilevel-action-…-informal-settlements`.
- **`accessibility-public-green-areas-…-belo-horizonte-brazil`**
  (in_window_not_returned, best_fused_rank **349**). It matches "Brazil"
  literally, so it stayed reachable — rank 349 is inside the window only
  because the cap-2 fill digs deep (see §4). But the doc's windowed
  chunk pair changed with the reshuffle and neither scored ≥ 0.09. Same
  doc was returned flag-off.

Verdict: M1 demoted the synonym-dependent golden to the fused floor; M2
removed the terms (emissions/brazilian/brasil) that used to carry both
goldens; M3 floor-cut the one that survived in the window.

### q10 "Have we published anything to do with urban finance since 2020?"

alias_lane_size=6: battery buses, e-buses, infrastructure funding,
mobility financing, costs, economic. lane_contribution d/s/alias =
**1/4/4** — the sparse lanes dominate; dense contributed 1 of 5 returned.

- **Newly matched flag-on:**
  `assessing-financing-challenges-…-electric-bus-program-india` — a
  literal finance-vocabulary doc additionally reached by the Electric
  Mobility aliases ("e-buses", "battery buses"). q10's golden docs *are*
  original-query matchers ("financing", "finance", "funding" in titles),
  so the double-count works **for** them — the asymmetry the brief
  predicted, confirmed.
- Countervailing M3 losses kept the gain to +0.10:
  `changing-demand-preference-electric-vehicles-ho-chi-minh-city` sat at
  fused rank **45** — comfortably in the window — and was still not
  returned (windowed chunks < 0.09); returned count collapsed 15 → 5.
  `synergizing-land-value-capture-tod` at 374, same story.

Verdict: q10 is the controlled contrast that confirms M1's sign flip:
double-counting helps when goldens match the raw query, hurts when they
need synonyms (q3/q4/q6/q7). The cap is not the lever — q10's 6 expansions
helped while q3/q4/q7's 2 hurt (brief question 5: confirmed not the cap).

## 3. Spec check — must the alias lane include the original query?

Design spec §4.3, quoted exactly:

> - original dense + original sparse at **2× weight**;
> - each variant's dense + sparse at 1×;
> - alias-expansion lane (deterministic tier) at 1×;

and:

> `expand_query_conservative` OR-stuffing is retired in favor of the alias
> lane — same idea, correct mechanics — but only after the P2 gate passes
> (§7).

The spec names an "**alias-expansion lane**" and never says it carries the
original query. `" OR ".join([request.query] + …)` at main.py:1116 is an
**implementation choice, not a spec mandate** — and it is the choice that
creates M1. An expansions-only lane is fully spec-consistent. (Note the
spec's "same idea, correct mechanics" also presumes content parity with
the retired stuffing, which M2 shows was not delivered.)

## 4. `rerank_candidates` reconciliation (brief question 3)

`rerank_candidates = 100`. The seeming contradiction — FNs at fused rank
349/374 labeled `in_window_not_returned` — is resolved by the cite
reranker's `per_doc_cap = 2`: `_select_candidates` iterates the ENTIRE
fused list (500 nodes) in order, taking at most 2 chunks per doc until 100
slots fill. When the head of the fused list is dominated by many chunks of
few docs (which the flag-on literal-match concentration makes worse), the
fill reaches deep ranks; a chunk at fused rank 349 is legitimately
selected if fewer than 100 cap-passing chunks precede it. The attribution
classifier (`lane-attribution.ts`) tests membership against the **actual**
recomputed window ids, not a rank threshold — the labels are correct.
`below_window` at rank 500 (q4) is the fusion_top_k boundary itself.
Corollary: window membership is doc-concentration-dependent, and
"in window" does not mean "well-ranked" — it can mean "represented by two
wrong chunks" (M3).

## 5. Golden-set artifacts checked (brief question 7)

The v3.2 deltas are trustworthy; the absolute levels are deflated:

- q1/q4/q10/q11 carry expected URLs regenerated as `""`
  (`2020_acciones-federales-planeacion-urbana_0152` in q1/q10/q11;
  `bridging-…-brazil-india-and-indonesia` and
  `wri_brasil-root_causes_2024_disaster_rs` in q4) — docs with no `url`
  in the qa documents row. An empty string never slug-matches, so these
  are permanent FNs on BOTH sides (q4's recall ceiling is 0.667 as
  scored). Both runs actually RETRIEVED both q4 ""-docs (they appear as
  `documents/<external_id>.pdf` fallbacks in retrieved_urls, then get
  counted as false positives). Checked all four queries in both reports:
  every ""-doc's retrieval status is symmetric across runs, so **no Δ is
  biased**. True q4 recall is 6/6 → 4/6 — the −0.333 stands.
- Same class of issue: q1 expects
  `wri.org.cn/research/rail-plus-property-…-shenzhen` but the service
  returns that doc as `documents/2015_rail-plus-property-shenzhen_00032.pdf`
  — unmatchable, symmetric in both runs.
- Hygiene follow-up (post-P2, eval workstream): regenerate with a
  file-path fallback (`documents/<external_id>.pdf`) for URL-less docs, or
  score the gen-1 harness by external_id as run-evalset.ts already does.

Also (brief question 6): no real golden doc moved to `never_retrieved`
flag-on that was retrieved flag-off — q7's `integrating-national-policies`
and q3's `improving-school-infrastructure` were missed by BOTH runs. The
pool did not lose goldens; the window representation and floor did the
damage. Reranker-vs-pool: both, in sequence — the pool's fused ordering
changed (M1+M2), the window's chunk selection followed (M3), the reranker
scored what it was given against the original query, honestly.

## 6. Candidate fixes, smallest first

1. **Drop the original query from the alias lane** — main.py:1116 becomes
   `" OR ".join(understanding.alias_expansions)`. One line, P2 scope,
   spec-consistent (§3 above). Hypothesis: eliminates M1 — literal
   matchers stop double-dipping, the alias lane becomes pure additive
   recall, fused ranks of synonym-reached goldens recover (q4's
   prepared-communities regains parity footing; q3/q6/q7 similar). Risk:
   an expansions-only OR query ("carbon OR Climate Change") is less
   anchored, so the alias lane's own ranking gets noisier — bounded by
   its 1× weight, the 2× originals, and the §4.4 reranker guard. q10's
   gain should survive (it came from alias vocabulary, which stays).
2. **Preserve curated order in `AliasExpander.expand`** — replace the
   alphabetical `sorted(...)[:max_terms]` with seed/db insertion order,
   and stop injecting the tag label as an expansion candidate. ~3 lines,
   P2 scope. Hypothesis: restores the curated terms the old dictionary
   led with (financing/funding for q10/q11; emissions for q3/q4 via
   Pollution/Climate Change groups; kids/students unavailable — that part
   is the deferred geo/demo gap). Determinism is preserved (seed order is
   fixed; the DB fetch needs `ORDER BY a.id` or equivalent to pin it).
   Risk: effectively none — it changes which 2 of the same group's terms
   are chosen.
3. **Persist `fused_nodes` + per-chunk rerank scores in attribution runs**
   (eval-side, P2 scope, diagnostic not behavioral): the classifier
   consumed the fused snapshot in-flight; saving it makes the M3
   chunk-substitution claim directly checkable per FN and closes the one
   assumption in this analysis (pool-independence of rerank scores).
4. **Do NOT retune the 2× weight** (brief question 4): raising originals
   to 3–4× shrinks the alias lane toward a no-op without restoring lost
   vocabulary (M2), and M1's asymmetry persists at any scale while the
   query rides in both sparse lanes. Modeling makes this clear: the
   literal:synonym sparse-mass ratio is (2w + w_a)/(w_a) regardless of
   the multiplier chosen. Fix the structure, not the scalar.
5. **Do NOT tighten the expansion cap** (brief question 5): q10
   (size 6) improved; q3/q4/q7 (size 2) regressed. The cap does not
   predict outcomes.
6. **Post-P2 design items:** geo/demographic facet for the three unmapped
   groups (operator-ruled deferred; note it also touches q3/q4/q6, not
   just q2); golden-set URL hygiene (§5); and, if regressions persist
   after fixes 1–2, revisit the M3 coupling — e.g., floor a doc on the
   max rerank score over its windowed chunks chosen per-doc by best
   fused rank, or let `_select_candidates` pick each doc's chunks by a
   stable per-doc order instead of global fused order.

## 7. Experiment plan (for operator approval — NOT run)

**Experiment: fixes 1+2 together, v3.2 A/B on the unchanged instrument.**

1. Apply fix 1 (expansions-only alias lane) and fix 2 (curated-order
   selection, no label injection) in the worktree. Both touch code
   reachable only when `lanes_active(...)` — flag-off stays byte-identical
   by construction; the existing leak-detector suite plus a flag-off
   eval re-run proves it (expect recall Δ=0.0000 vs
   `eval-report-1787197542706.json`).
2. Unit tests: alias-lane query string no longer contains the original
   query; expander returns seed-order terms; label never emitted.
3. Rig unchanged (brief §9): local service on qa RDS, postgres/sparse.
   Flag-on run + attribution run with `EVAL_LANE_ATTRIBUTION=1
   EVAL_LABEL=p2-v32-fix1` and `return_intermediate_results` persisting
   `fused_nodes` (fix 3) for any remaining FN.
4. **Success criteria (v3.2 gate rule):** flag-on macro excl. q10 ≥
   flag-off 0.7424; per-query: q3/q4/q6/q7 recover to their flag-off
   values (0.8333/0.6667/1.0000/0.7500), q10 holds ≥ 0.4000, q2 stays a
   known gap, zero `displaced_by_variant_lane`; answer chunk R ≥ 0.3307.
5. **Decision tree:** all green → P2 gate re-run proper. q10 loses its
   gain but regressors recover → operator call (the gain came from alias
   vocabulary; if fix 1 costs it, the expansions-only lane may need the
   Public Finance group's curated leads, which fix 2 supplies — read the
   attribution before touching anything else). Regressors persist →
   read the persisted `fused_nodes` for the failing FNs before proposing
   anything further; M3 coupling becomes the suspect.

Estimated cost: ~30 min of eval wall-clock, no deploy, both flags remain
OFF in every deployed environment.

## 8. Experiment results (2026-08-20 — operator-approved run of fixes 1+2)

Commit `ce9993b` (alias lane carries expansions only, curated order, no
label emission; `db_expander` ordered by `created_at`, verified against qa
to be seed insertion order). Rig identical to the v3.2 gate: worktree
service on qa RDS, postgres/sparse. Answer-retrieval skipped
(operator-ruled broken).

- **Leak check PASS:** flag-off re-run (`eval-report-1787238023956.json`)
  matches the v3.2 flag-off baseline per-case Δ=0.0000 on all 11 queries.
- **Flag-on** (`eval-report-1787238169266.json`, attribution
  `eval-report-p2-v32-fix12-attribution-1787238329208.json`): overall
  0.5998 → **0.6421**; macro excl. q10: 0.6198 → **0.6667** (flag-off
  0.7424). Zero `displaced_by_variant_lane`.

| Query | off | on pre-fix | on fix1+2 | verdict |
|---|---|---|---|---|
| q3 | 0.8333 | 0.6667 | **0.8333** | recovered |
| q6 | 1.0000 | 0.8571 | **1.0000** | recovered |
| q7 | 0.7500 | 0.5000 | **0.7500** | recovered |
| q10 | 0.3000 | 0.4000 | **0.4000** | gain held |
| q1/q5/q8/q9 | — | — | — | flat |
| q2 | 0.8333 | 0.5000 | 0.5000 | known geo gap (ruled) |
| q4 | 0.6667 | 0.3333 | 0.3333 | NOT recovered — see below |
| q11 | 0.0909 | 0.0909 | **0.0000** | new marginal loss — see below |

**q4 is the q2 geo gap in disguise.** Post-fix its two failing goldens
went from in_window/below_window to **never_retrieved**: with the query
out of the alias lane, no lane reaches them at all. The load-bearing
flag-off terms were `brazilian`/`brasil` — the unmapped geo group. (The
Portuguese-language belo-horizonte doc needs "brasil"; raw "Brazil"
doesn't stem to it.) The deferred geo facet's measured cost is now
q2 −0.333 **and** q4 −0.333.

**q11 lost its single marginal doc** (`financing-the-urban-transition…`,
1/11 flag-off): post-fix it sits at fused rank 117, in-window,
floor-cut — the restored finance aliases flood the sparse lanes and its
windowed chunk pair changed (§M3). A floor-marginal query wobbling on a
chunk-representation change, not a structural regression.

**Verdict:** M1+M2 confirmed as the cause of the recoverable regression —
every non-geo regressor recovered exactly, q10's gain survived. The
remaining flag-on deficit (−0.0757 macro excl. q10) is q2+q4 (geo
vocabulary, deferred by ruling; −0.067 of it) and q11 (floor-marginal;
−0.009). Decision now with the operator: gate P2 on "flag-on ≥ flag-off
excluding the ruled geo-gap queries," or pull the geo facet forward.

## 9. Non-goals (restated from the brief)

No blind retuning; no flag flips anywhere deployed; no push, no PR, no
deploy; no modification of the v3.2 golden set or the P0/v3.2 baselines;
the geo facet stays deferred; the 0.8583 threshold stays dead.
