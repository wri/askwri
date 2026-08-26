# Query Expansion — P3 (LLM sidecar) Implementation

Parent design: `2026-08-19-query-expansion-design.md` §4.1, §4.2, §5, §7.
State going in: P1 (deterministic tier + chips) + P2 (multi-lane RRF + alias
lane + topic/geo tag sensing) shipped on `qa`; flags on in qa, off in
production. #361 (chips render in content column) merged.

## Goal

Add an LLM understanding sidecar that augments the deterministic tier with:
query variants, LLM-grade facet extraction, intent classification, and
disambiguation candidates. Flagged, dark, gated; deterministic-first; qa-only.

## The five flags (design §7)

| Flag | Default | Status |
|---|---|---|
| `query_understanding_enabled` | False | shipped (P1) |
| `query_expansion_lanes_enabled` | False | shipped (P2) |
| `query_understanding_llm_enabled` (NEW) | False | this work |
| `EXPANSION_LANE_WEIGHT` | 2.0 | knob (P2) |
| `DEEP_RESCUE_MAX` | 10 | knob (P2) |

Flag-off = byte-identical to deterministic-only (the `build_sparse_query`
discipline). No flag flip in production. qa flip is a follow-up after the gate
passes, exactly as #358 followed #357.

## Reuse (don't reinvent)

- **Request-path posture**: `app/query_translate.py` — sync `OpenAI` client,
  `response_format` JSON, `lru_cache(512)` keyed on query, short timeout,
  `max_retries=0`, failure-soft. This is the per-query sidecar's template.
- **Strict schema**: `worker/llm.py` `chat_json` — `response_format:
  {"type":"json_schema","json_schema":{"name":...,"strict":True,"schema":...}}`.
  This is how design §5's "reject the whole object on unknown facet /
  out-of-range confidence" is enforced at the LLM boundary.
- **One attempt, no retry loop** (design §5): P3 reuses `chat_json`'s strict
  json_schema mechanism but NOT its 2-attempt loop. One call, one budget;
  miss ⇒ degrade to deterministic tier (record in `understanding.degraded`).

## Slices (each a PR; dark until gate passes)

### Slice 1 — the sidecar call, flag-dark (this PR)
- `config.py`: `query_understanding_llm_enabled: bool = False`,
  `query_understanding_llm_model: str = "gpt-5.6-luna"` (matches worker;
  design decision #5: small GPT-5.6-class via existing OpenAI path, NOT Bedrock),
  `query_understanding_llm_timeout_s: float = 4.0`.
- New `app/understanding_llm.py`: `build_understanding_llm(query) -> dict | None`.
  One strict json_schema call asking for `{intent, facets:[{facet,value,
  confidence}], variants:[str], disambiguation:[str]}` with `facet` restricted
  to the `FACET_NAMES` enum. `lru_cache(512)` by query. `max_retries=0`, short
  timeout. Failure-soft: returns `None` on any error/timeout/parse failure
  (caller records `degraded`). Strict: an unknown facet name or OOR confidence
  in the LLM response rejects the whole object (returns None, degraded).
- `main.py`: after deterministic `build_understanding`, inside the existing
  `understanding_active` guard, if `settings.query_understanding_llm_enabled`,
  call `build_understanding_llm` via `asyncio.to_thread` (blocking OpenAI call)
  within the timeout budget. Merge into `understanding`:
  - `intent` (LLM's, if returned),
  - `variants` (dedupe vs originals, cap 2 per design §4.1),
  - `facets` (LLM facets as `source="llm"`, **`action="suggest"` in slice 1** —
    visible, never applied as a hard filter while the confidence threshold is
    uncalibrated; design §7 says thresholds are DERIVED from a labeled set,
    never hand-picked),
  - `suggestions` (disambiguation candidates as `type="disambiguation"`).
  On failure/timeout: `understanding.degraded.append("understanding_llm")`.
  Record `timings["llm_ms"]`.
- No schema change to `QueryUnderstanding` — `intent`, `variants`,
  `Facet(source="llm")`, `Suggestion(type="disambiguation")` already exist.
- No contract change — `route.ts:222` projects `query_understanding` whole;
  LLM fields flow to the UI as-is.
- **Slice 1 is blocking within a budget** (simpler, correct, flag-dark). The
  non-blocking parallel timeline (design §4.2) is slice 2.

### Slice 2 — variant lanes (design §4.3) — THIS SLICE
Each LLM variant gets a dense+sparse retrieval lane at 1× weight (vs 2× for
the original lanes), fed into `extra_lanes`. This is the real P3 retrieval
value: variants widen the candidate pool pre-rerank; the reranker still only
sees the original query (design §4.4 — the precision guard). `extra_lanes`
currently holds one retriever per lane (tag lanes); a variant lane needs a
dense retriever on the variant query (+ optionally sparse). Gate: cite sets must
not regress (2× original weight bounds displacement; the cite gate catches it).

### Slice 3 — non-blocking timeline (design §4.2) — moved here
Fire the sidecar in parallel with original dense/sparse; fuse if it lands
within the remaining budget, else skip. Worth building only AFTER variant
lanes exist (slice 2): on qa the LLM is ~2-3s and stage 1 ~0.3-1s, so a
parallel fire would mostly timeout-degrade the LLM (losing variants/intent)
until either the LLM is faster or variants drive lanes. Reordered from the
plan's original slice 2 because slice 1's blocking call is correct while
variants are decorative.

### Slice 4 — catalog-mode presentation (design §3)
Intent=catalog queries get the same cite results ordered by date with year
facets applied + chips shown. New results surface, not a new page.

### Slice 5 — per-query adaptation
The intent signal drives `expansion_lane_weight` per query type (the #353
remaining tradeoffs d4/q1/q3/q8/q11 need per-query adaptation — P3-adjacent).

### Slice 6 — abstention input (#356)
The intent classifier ("is this a binary_presence query?") is a candidate
abstention signal for the negatives (d8/d9/d10 at floor 0.09).

## Tests (slice 1)

- `tests/test_understanding_llm.py` (new): mock `openai.OpenAI` —
  (a) valid LLM output merges into understanding (facets as `suggest`,
  variants deduped/capped, intent set);
  (b) unknown facet name in LLM response ⇒ whole rejection (None, degraded);
  (c) OOR confidence ⇒ whole rejection;
  (d) timeout ⇒ None, degraded;
  (e) non-JSON ⇒ None, degraded;
  (f) lru_cache hit on repeat query (one OpenAI call for two identical queries).
- `tests/test_understanding.py`: extend `test_flag_defaults_off` to assert
  `query_understanding_llm_enabled` defaults False. Add: flag off ⇒
  `build_understanding_llm` is never imported/called (the no-op discipline).
- Leak detectors after the `main.py` hook: `test_diagnostic_parity.py`,
  `test_query_nonblocking.py`.

## Gate (slice 1)

- `evaluation/eval-minimal.ts --compare` on cite_01 + cite_02,
  `CITE_LOGIT_FLOOR=0.0` for both flag states. LLM flag ON must not regress
  precision vs LLM flag OFF (excluding correctly-faceted queries per design §7).
- Slice 1's suggest-only llm facets make regression provably impossible
  (suggest facets don't filter), so the gate is a belt-and-suspenders check.

## Out of scope (design §9)

Non-EN sparse-lane retrieval, threshold/tier re-derivation, reranker swaps,
answer synthesis, facet-management UI beyond chips.

## Per-mode strategy (cite = recall-first, answer = precision-first) — slice 5 design

User direction 2026-08-25: cite-type queries privilege recall over precision;
answer-type queries favor precision. The sidecar's `intent` field
(topical/known_item/catalog) is the per-query axis on top of mode.

### Current state (gaps this closes)
- `EXPANSION_LANE_WEIGHT` in qa.tfvars is a **dead knob** — not read anywhere
  in code. The original-lanes 2× multiplier is hardcoded in
  `HybridFusionRetriever._retrieve` (main.py:327). qa.tfvars sets 0.25 but it
  has no effect.
- `dense_weight`/`sparse_weight` are request-level (0.5 default, same for both
  modes); the only mode-specific tuning today is `fusion_top_k` (500 cite /
  100 answer) and the reranker (per-doc caps + top_n).
- The `intent` field flows to the UI but drives nothing in retrieval.

### The lever: per-mode expansion-lane weight
Wire the dead `EXPANSION_LANE_WEIGHT` knob (or a per-mode pair) so the
expansion lanes' RRF weight is config-driven, and default it per mode:

- **Cite (recall-first)**: expansion lanes at **1×** (originals at 2×). More
  variant/tag candidates survive fusion → wider recall pool for the
  100-slot rerank window. This is the current effective behavior (lanes at
  1×, originals at 2× when any lane materializes) — the +10.6 MAP win.
- **Answer (precision-first)**: expansion lanes at **0.25×** (or off). Fewer
  candidates → the reranker sees a tighter, more-precise pool; variants don't
  dilute a known-item or targeted answer.

Minimal change:
1. `config.py`: replace the dead `EXPANSION_LANE_WEIGHT` with
   `cite_expansion_lane_weight: float = 1.0` and
   `answer_expansion_lane_weight: float = 0.25` (or a single knob applied per
   mode). Keep the env var name `EXPANSION_LANE_WEIGHT` as an override for
   both (back-compat with qa.tfvars).
2. `HybridFusionRetriever`: take the expansion-lane weight as a constructor
   arg (from `request.mode`-selected config); apply it to all `extra_lanes`
   (the `weight` field, currently `None` → sparse_weight). The 2× original
   multiplier stays (it's the recall-vs-precision asymmetry that bounds
   displacement).
3. `main.py`: pass the mode-selected weight into `HybridFusionRetriever`.

### The per-query axis: `intent`
On top of mode, `intent` (from the LLM sidecar) is the per-query discriminator:
- `catalog` (cite): results ordered by date with year facets applied (slice 4).
- `known_item` (answer): minimize expansion (the user wants one doc);
  expansion lanes off regardless of mode.
- `topical`: the mode default applies.

This makes slice 5 two parts:
- **5a**: wire the per-mode expansion-lane weight (the dead knob) + gate.
- **5b**: `intent`-driven overrides (known_item → expansion off; catalog →
  date-order + facets). 5b depends on the catalog-mode presentation (slice 4).

### Gate (5a)
eval-minimal cite_01 + cite_02 (cite mode, recall-first) must hold the +10.6
MAP win (lanes at 1×). A new answer-mode eval set (or the answer-retrieval
eval) must not regress with lanes at 0.25× — answer precision should improve
or hold, not drop. The dead-knob fix is a prerequisite: today's 0.25 in
qa.tfvars is doing nothing, so flipping it real is a behavior change that
needs the gate.
