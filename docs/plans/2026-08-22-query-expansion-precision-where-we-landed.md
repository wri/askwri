# Query-Expansion Precision Work — Where We Landed

> **Update 2026-08-26:** `EXPANSION_LANE_WEIGHT` in qa.tfvars was a dead knob
> (not read by code); it was wired for real and made per-mode in P3 (#369/#372).
> The numbers below were captured pre-determinism (the LLM sidecar was
> nondeterministic + lru_cached — a per-deploy lottery; fixed by #374 with
> `temperature=0`). For the current, reproducible state and the full P3 +
> per-mode tuning story, see
> `2026-08-26-p3-llm-sidecar-where-we-landed.md`.

**Date:** 2026-08-22
**Status:** Merged to `qa` (#357). Lanes + knobs enabled in qa via #358. Production unchanged (both flags OFF).
**Scope:** `search-service/app/bedrock_rerank.py`, `search-service/app/main.py`, `search-service/app/config.py`, `evaluation/eval-minimal.ts`, `terraform/environments/qa.tfvars`.

> For humans. A short read on what changed, what it does, the tradeoffs we accepted, and how to revert.

---

## TL;DR

We fixed a precision regression the expansion lanes introduced, and built the gate tooling to catch this class in future. Three new behaviors ship:

1. **Flood rerank** (active by default) — when one document floods the fused candidate set, a small second rerank surfaces that document's rerank-best chunk. Fixes the d3 regression (AP 25 → 100).
2. **AP regression gate** (`eval-minimal.ts --compare`) — the eval harness used to be recall-only; precision regressions passed silently. Now it asserts per-query AP and exits non-zero on regression.
3. **Two tuning knobs** (off by default, on in qa) — `DEEP_RESCUE_MAX` and `EXPANSION_LANE_WEIGHT` for the operator-judged tradeoffs on the remaining regressions.

The expansion lanes are now **on in qa** for the first time, with the knobs tuned. Production keeps both flags OFF.

---

## The problem this solved

The query-expansion lanes (P2.5 topic, P2.6 geo) were built to improve **recall** — surface more relevant docs by adding RRF mass to docs tagged with the query's nearby topics/geographies. They did: attainable recall rose on both cite golden sets.

But they regressed **precision** on several queries. The headline case (issue #353):

> **d3** "What has WRI written about decarbonizing container port and drayage operations?"
> Single expected doc. Flag-off: AP 100% (golden ranked #1). Flag-on: AP 25% (golden still retrieved, ranked ~4th).

The recall gate passed (`flag-on aR ≥ flag-off aR`), so this sailed through P2.5 and P2.6 unnoticed. The gate was **blind to ranking regressions** — it only checked whether goldens were *retrieved*, not where they *ranked*.

---

## What we found (the mechanism, in one paragraph)

Each document's rerank-best chunk is often **not** its top-2 chunks by fusion order. The golden's best chunk (a data table about drayage modal shares) sat at the doc's #10 by fused rank. The `per_doc_cap=2` candidate selector admitted only the top-2-by-fusion (which scored poorly at rerank), and the best chunk stayed in the discard pile. In flag-off, an accidental backfill re-added it; in flag-on, the lanes added enough diversity that backfill stopped firing, so the best chunk was excluded. The fix is a **second, small rerank on flooding documents** to surface their actual best chunk — not the top-2-by-fusion.

---

## What shipped

### 1. Flood rerank — `bedrock_rerank.py` (active by default)

When one doc owns more than `flood_doc_share` (default **0.50**) of the fused candidate set, re-rank that doc's top-K (default **10**) chunks and swap its rerank-best 2 into the main window.

- Fires only on floods (2 of 18 cite queries at the 0.50 threshold). Normal queries pay nothing.
- Cap and backfill unchanged, so queries that were winning via backfill (d12) are unaffected.
- **d3: AP 25 → 100, aR 100 → 100.** Zero new regressions.

### 2. AP regression gate — `eval-minimal.ts --compare`

```
npx tsx evaluation/eval-minimal.ts --compare <flag-off-report.json> <flag-on-report.json>
```

Asserts per-query `candidate AP ≥ baseline AP − AP_TOL` (default 0.05) and the existing macro recall gate. Exits 1 on regression. The precision class can't pass the gate silently again. Tolerance is env-tunable (`AP_TOL`, `AR_TOL`).

### 3. Tuning knobs — `config.py` (off by default; on in qa via #358)

| Knob | Default | qa value | What it does |
|---|---|---|---|
| `DEEP_RESCUE_MAX` | `0` (off) | `10` | 2nd-rerank up to N docs a non-dense lane surfaced that sit deep in fused order and miss the cap-2 window when the lanes add diversity. Helps d11/q11. |
| `EXPANSION_LANE_WEIGHT` | `None` (1×) | `0.25` | Expansion-lane RRF mass at 0.25× to cut ranking dilution (adjacent-topic docs reranking above goldens). Helps d7/d11. |

### 4. Lane metadata stamping — `main.py`

`HybridFusionRetriever` now stamps each fused node's `metadata["lane_ranks"]` so the reranker can target non-dense-lane docs without re-reading retriever state.

---

## The numbers (live, qa, 2026-08-22)

| | before this work (flag-off) | qa now (flags + knobs) |
|---|---|---|
| **cite_02 MAP** | 74.1 | **76.3** (+2.2) |
| **cite_02 aR** | 87.5 | **89.6** (+2.1) |
| **cite_01 MAP** | 37.6 | 37.1 (−0.5) |
| **cite_01 aR** | 71.1 | **77.9** (+6.8) |
| **d3** AP/aR | 100/100 | **100/100** |

Recall up materially on both sets. cite_02 MAP up. cite_01 MAP essentially flat while aR jumped — the lanes bring in more goldens at the cost of some ranking precision. d3 — the regression that started this — is fixed.

---

## The tradeoffs we accepted (read this before tuning)

No single setting clears the per-query AP gate. The queries pull in different directions:

| Query | What it wants | Why |
|---|---|---|
| d7, d11 | low `EXPANSION_LANE_WEIGHT` | Less lane mass → fewer adjacent docs diluting the golden's rank |
| d4, q8 | high `EXPANSION_LANE_WEIGHT` | More lane mass → more relevant docs surfaced |
| q1 | — | No topic-lane tags; not a weight lever |
| q3 | — | Golden isn't retrieved at all; recall problem, not ranking |
| q11 | `DEEP_RESCUE_MAX` | Golden is a sparse-lane doc sitting deep; rescue re-admits it |

We set `EXPANSION_LANE_WEIGHT=0.25` because d7/d11 are bigger regressions than d4/q8, and the net macro is positive. **This is a judgment call, not a correct answer.** If d4/q8 matter more for a given workflow, raise the weight (toward 1.0) or set it to `None`.

The knobs are env vars — tune live without a code change:

```
EXPANSION_LANE_WEIGHT=0.25   # try 0.5, 0.4, None — observe the gate
DEEP_RESCUE_MAX=10           # try 25, 0 — observe
```

---

## How to revert

**Disable the lanes + knobs in qa** (back to flag-off baseline):
- Remove the four vars added in `terraform/environments/qa.tfvars` (`QUERY_UNDERSTANDING_ENABLED`, `QUERY_EXPANSION_LANES_ENABLED`, `EXPANSION_LANE_WEIGHT`, `DEEP_RESCUE_MAX`) and redeploy. The flood rerank and AP gate stay (they're code, default-on and harmless).

**Disable the flood rerank** (only if it misbehaves):
- Set `FLOOD_DOC_SHARE=0` (disables the trigger) or `FLOOD_RERANK_K=0`. Env var, no code change.

**Full revert to pre-#357:** revert commits `c20980a` (qa) and the `fix/issue-354-negatives` squash. Not recommended — the AP gate and flood rerank are pure wins.

---

## What's not fixed (and where it's tracked)

- **#353 remaining (d4, q1, q3, q8, q11):** irreducible single-knob tradeoffs. Need per-query adaptation (the `query_understanding` tier setting the weight per query type). Out of scope here; tracked in #353.
- **#354 / #356 (negatives d8/d9/d10):** negative queries return 19-22 docs at the production floor. Their top rerank scores overlap a perfect positive (d3's golden), so no floor separates them. Needs an abstention signal beyond rerank score. Tracked in #356.

---

## Key files

- `search-service/app/bedrock_rerank.py` — `_surface_flooding_best` (flood rerank), `_deep_rescue`
- `search-service/app/main.py` — lane-rank metadata stamping; `expansion_lane_weight` wiring
- `search-service/app/config.py` — `flood_doc_share`, `flood_rerank_k`, `deep_rescue_max`, `expansion_lane_weight`
- `evaluation/eval-minimal.ts` — `--compare` mode (AP gate)
- `terraform/environments/qa.tfvars` — qa env vars (flags + knobs)

---

## Gate procedure (for future retrieval changes)

1. Boot search-service flag-off, run `eval-minimal.ts` on both cite sets → baseline reports.
2. Boot flag-on (with your change), run again → candidate reports.
3. `npx tsx evaluation/eval-minimal.ts --compare <flag-off-report> <flag-on-report>` per set.
4. **Gate PASS** = macro aR held AND no per-query AP regression beyond tolerance.
5. **Gate FAIL** = regression. Don't merge without operator sign-off on the tradeoff.

The gate convention is `CITE_LOGIT_FLOOR=0.0` (disables the floor) to match recall baselines. Don't change it without operator sign-off.
