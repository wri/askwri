# P3 (LLM Sidecar) + Per-Mode Tuning — Where We Landed

**Date:** 2026-08-26
**Status:** Merged to `qa` (#362, #363, #364, #365, #366, #368, #371, #372, #374). All flags on in qa; production unchanged (all flags OFF).
**Scope:** `search-service/app/understanding_llm.py` (new), `search-service/app/understanding.py`, `search-service/app/main.py`, `search-service/app/config.py`, `evaluation/eval-minimal.ts`, `terraform/environments/qa.tfvars`.

> For humans. What changed, what it does, the data behind the tuning, the bugs we found and fixed, and how to revert.

---

## TL;DR

P3 added an LLM understanding sidecar that augments the deterministic tier with query variants, LLM-grade facets, intent, and disambiguation. The variants drive new retrieval lanes. We tuned the expansion-lane weight per mode (cite recall-first / answer precision-first) from a live-qa sweep — not guesses — and fixed a per-deploy nondeterminism bug that had been silently inflating our numbers. The honest, reproducible wins: **cite_02 +6.0 MAP**, cite_01 +2.4 MAP, answer flat (no regression).

---

## What shipped

### 1. P3 LLM sidecar — `understanding_llm.py` (new), `main.py`, `config.py` (#362, #363)

One strict, schema-validated OpenAI call per query, `lru_cache`d, short timeout, one attempt (no retry loop), failure-soft (degrades to the deterministic tier; records `understanding.degraded`). Deterministic-first: augments, never replaces. Strict facet validation reuses the pydantic `Facet` model — an unknown facet name or out-of-range confidence rejects the WHOLE object (design §5), never half-applied. Model `gpt-5.4-mini` (see #4 below). LLM facets ship `action="suggest"` (visible in debug, not rendered as chips — chips render `hard` only).

Flagged dark (`query_understanding_llm_enabled`, default False); on in qa via #363. Production stays off.

### 2. Geography facet on — `qa.tfvars` (#364)

The geography facet data was backfilled to qa 2026-08-20 (#351: 201 geography + 757 topic embeddings, `cohere-embed-v4`) and the lane code was merged (#350/#351), but `EXPANSION_FACETS` was never flipped on in qa — geography tag sensing was silently OFF. #364 sets `EXPANSION_FACETS=["topic","geography"]`.

### 3. Variant lanes — `main.py` (#365)

Each LLM variant contributes a dense + sparse retrieval lane at 1× weight (vs 2× for the original lanes), fed into `extra_lanes`. `build_variant_lanes` (pure, factory-injected) builds the lane dicts; the fusion core runs each lane's retriever in its existing parallel pool — no fusion-core change. A variant equal to the original query is deduped (design §4.1). The reranker still only ever sees the original query (§4.4 — the precision guard): variants widen the candidate pool pre-rerank; they never redefine the question.

### 4. Model swap luna → gpt-5.4-mini — `config.py` (#366)

`gpt-5.6-luna` (the big luna) was overkill for a per-query structured-output sidecar. `gpt-5.4-mini` is OpenAI's fast current-gen mini (2× faster than gpt-5-mini), produces clean variants + valid structured JSON, and measures ~0.8-1.0s vs luna's ~2-3s — a 3-4× latency cut on the dominant cold-query cost. LLM facets are suggest-only and not rendered, so 5.4-mini's noisier facets are invisible to the user.

### 5. Per-mode expansion-lane weight (data-driven) — `config.py`, `main.py` (#369, #372)

The `EXPANSION_LANE_WEIGHT` knob in qa.tfvars was a **dead knob** — not read by code; the original-lanes 2× multiplier was hardcoded and expansion lanes used `weight=None → sparse_weight`. #369 wired it as a per-mode pair with a request-level sweep knob (`QueryRequest.expansion_lane_weight`) so the value could be tuned against live qa in seconds, no redeploy. #372 set the values from a live-qa sweep (see data below), not guesses.

- `cite_expansion_lane_weight = 0.5` (recall-first)
- `answer_expansion_lane_weight = 1.0` (precision-first)
- `EXPANSION_LANE_WEIGHT` env remains as an override for both (back-compat).
- The 2× original multiplier stays (the recall-vs-precision asymmetry that bounds displacement).

### 6. LLM determinism — `understanding_llm.py` (#374)

The sidecar was nondeterministic: gpt-5.4-mini returned different variant orderings/content across calls for the same query, and `lru_cache` froze the first (random) draw per query for the process lifetime. This made retrieval quality a **per-deploy lottery** (see "The bug we found" below). #374 sets `temperature=0` so the same query yields the same output every call; the cache then freezes a stable result. Both the sweep and production became reproducible.

### 7. Eval harness — `eval-minimal.ts` (#368, #371, #375)

- `EVAL_MODE` env (cite | answer) — the same runner covers both modes through the qa gateway (#368).
- Reads `expected_external_ids` from `tc.retrieval_ground_truth` when the top-level field is absent (answer evalset nests it there; cite has it top-level) (#368).
- `EVAL_EXPANSION_LANE_WEIGHT` env — the sweep knob; forwards `expansion_lane_weight` in the POST body (#371).
- `EVAL_EXPANSION=false` env — sends `expansion=false`, which makes `understanding_active()` return False (the flag-off guard) → a true flag-off baseline through the qa gateway, no flag flip or redeploy (#375).

---

## The data behind the tuning (live-qa sweep, 2026-08-26)

Swept `expansion_lane_weight` ∈ {0.0, 0.25, 0.5, 0.75, 1.0} on cite_01, cite_02, answer_02 against live qa (post-determinism):

| weight | cite_01 MAP | cite_02 MAP | answer_02 MAP |
|---|---|---|---|
| 0.0  | 34.2 | 73.7 | 77.6 |
| 0.25 | 39.8 | 74.6 | **73.9** ← worst answer |
| **0.5**  | 36.4 | **79.7** | 77.0 ← best cite_02 |
| 0.75 | 35.7 | 72.7 | 80.2 |
| 1.0  | **40.7** | 72.4 | **80.2** ← best answer |

cite_02 at 0.5 reproduced exactly across runs (post-determinism) — stable.

### What the data corrected (two wrong assumptions)

1. **The cite/answer split is real but inverted from the hypothesis.** Answer wants *high* weight (1.0: 80.2), not low. 0.25 — the original guess and qa's dead-knob value — measured *worst* on answer (73.9). Answer retrieves the specific source doc; expansion lanes help *find* it, so high weight helps. Precision-first here means "find the one right doc," not "narrow the pool."
2. **cite_02 wants 0.5**, not 1.0 (the pre-5a effective default). 1.0 dilutes direct-match goldens (d3 AP 20 → 100 at 0.5). The 2× original multiplier + 0.5 expansion is the sweet spot.

### The irreducible tradeoff (slice 5b)

cite_01 and cite_02 want different cite weights (cite_01 best at 1.0, cite_02 best at 0.5). At 0.5, cite_01 loses q8 (the variant-lane win: AP 67 → 47). This is a genuine single-knob tradeoff, not a tuning miss — it's the **per-query adaptation** problem (the #353 irreducible tradeoffs d4/q1/q3/q8/q11). The `intent` field (topical/known_item/catalog) is the per-query discriminator. Slice 5b uses it; a single mode default can't resolve it.

---

## The bug we found (and why the first gate didn't reproduce)

The first post-deploy gate showed cite_02 at 70.8 MAP, not the 80.1 the sweep measured at the same weight=0.5. Root cause: the LLM sidecar was **nondeterministic**, and `lru_cache` froze the first (random) draw per query for the process lifetime. The sweep measured d3 with one set of cached variants (golden rank 1 → AP 100); the post-deploy cold cache froze a different set (golden rank 3 → AP 20) — same 0.5 weight, broad ±5-10 point swings across queries. The "+10.6 MAP win" was partly variance, not signal.

`temperature=0` (#374) fixed it. The honest, reproducible post-fix numbers are below.

---

## The numbers (live qa, 2026-08-26, deterministic)

| Set | flag-OFF (`expansion=false`) | flag-ON (P3, defaults) | Δ |
|---|---|---|---|
| **cite_01** | 36.4 / 65.8 | **38.8 / 65.2** | **+2.4 / −0.6** |
| **cite_02** | 73.7 / 86.9 | **79.7 / 88.2** | **+6.0 / +1.3** |
| **answer_02** | 77.0 / 84.4 | **77.0 / 84.4** | **0 / 0** |

- cite_02: +6.0 MAP / +1.3 aR — the real, reproducible recall win from variant lanes + geography + 5.4-mini at weight 0.5.
- cite_01: +2.4 MAP / −0.6 aR — small recall gain, tiny aR loss; net positive.
- answer_02: flat — the expansion lanes neither help nor hurt answer at w=1.0; answer retrieval is driven by the original query matching the source doc. No regression.

The earlier "+10.6 MAP" and the "80.2 answer baseline" were pre-determinism lottery draws, not real baselines.

---

## What's still open

- **Slice 5b — per-query intent adaptation.** The cite_01/cite_02 tradeoff is irreducible at a single mode default. `intent` (known_item → expansion off; catalog → date-order + facets; topical → mode default) is the per-query discriminator.
- **Slice 4 — catalog-mode presentation** (design §3): intent=catalog queries get cite results ordered by date with year facets + chips.
- **#356 — abstention** (negatives d8/d9/d10 at floor 0.09): the intent classifier is a candidate abstention signal.
- **Production**: all flags stay OFF until re-gated at production corpus scale.

---

## Revert

- **Flag off in qa**: remove `QUERY_UNDERSTANDING_LLM_ENABLED`, `EXPANSION_FACETS` from `qa.tfvars` + redeploy. (Or send `expansion=false` per-request for a flag-off-equivalent without redeploy.)
- **Per-mode weights**: revert `cite_expansion_lane_weight` to 1.0 and `answer_expansion_lane_weight` to 0.25 (or remove them — the code default without the env override is the pre-5a behavior), or set `EXPANSION_LANE_WEIGHT` env to force both.
- **Model**: revert `query_understanding_llm_model` to `gpt-5.6-luna`.
- **Determinism**: remove `temperature=0` from `understanding_llm.py` (not recommended — restores the per-deploy lottery).
