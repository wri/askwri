# First live route sweep — findings

**Date:** 2026-11-18. **Target:** `https://qa.askwri-app.org`, image
`sha256:98a0835e…` (deploy of `6ad67fc`). **Run:** `--stage sweep --label routes-v1`,
`gpt-5.4-nano` vs `gpt-5.4-mini`, 10 frozen cases × 4 routes × 2 models = 80 calls.
**Artifacts:** `evaluation/baselines/2026-11-18-route-sweep-routes-v1.{json,md}`.

The harness works: 80 calls, every one recorded, the gate failed on two of them and said so. This was
its first run against a deployed QA.

## The gate failed on two calls, both `batch-why`

| Call | Provenance | What the route returned |
|---|---|---|
| `q8_yantian-port-mode-shift-targets` / `gpt-5.4-nano` | `produced=false`, `fallback_reason=parse_error` | six canned `"This passage provides relevant context for the query."` explanations. `parseError: Expected ',' or ']' after array element … position 759`. |
| `q5_bikeshare-trip-substitution` / `gpt-5.4-mini` | `produced=true`, **`sanitized=true`** | 26 explanations, of which items 25 and 26 are canned text substituted for model output; the first 24 are genuine. |

**`gpt-5.4-nano` is the model QA runs for `batch-why` today**, so the first row is not a candidate
risk — it is what a user gets on that case now. Both failures are the design's named anti-goal: a
route that answers, plausibly, from canned text.

## What the artifact cannot tell us, and why

The recorded `request` is **the sweep's payload**, not the body the route sent upstream: `runCall`
stores `{...job.payload, model}` (`sweep.ts:102`). So the token cap, the temperature and — critically —
the provider's `finish_reason` are all invisible here. A truncated reply and a malformed reply look
identical in this artifact.

The shape of both failures is consistent with truncation: `why`'s budget is
`min(200 + 80 × passages, 3000)`, so 6 passages get 680 tokens and 26 get 2280, and the parse error is
at character 759 of a 6-item array. The `gpt-5.4` family spends reasoning tokens out of the same
`max_completion_tokens` budget (the registry's own comment says so), which leaves less for the visible
JSON. **That is a hypothesis, not a finding**, and this artifact cannot decide it.

## What would decide it, cheapest first

1. **One probe case at the real budget.** `npm run probe:models -- --task why --models gpt-5.4-nano`
   runs the `why` profile and records `finish_reason` — `length` confirms truncation, `stop` refutes it.
   Cost: one call.
2. **If the probe's fixture does not reach the same shape** (it carries 25 passages; the failing case
   had 6), add a `--passages 6` fixture knob rather than hand-writing a body.
3. **Only then** decide the route change. If it is truncation, the fix is a budget that accounts for
   reasoning tokens on the `why` path, and it is a *route* change with its own gate — not a sweep tweak,
   and not something to slip into this plan's evidence run.

## What this run did establish

- The harness's mechanical checks catch exactly what they were built for: a parse failure and a
  substitution, both flagged with the case, route and model.
- The bar's numbers, first time computed: `batch-why` p95 9.3 s (nano) / 5.2 s (mini);
  `batch-relates` 5.9 / 3.6 s; `alignment` 3.4 / 1.8 s; `translate` 3.0 / 1.9 s. Cost runs
  **+201% to +243%** for `gpt-5.4-mini` over `gpt-5.4-nano` on every route that reports usage;
  `translate` reports none, so its cost is unmeasured rather than zero.
- `batch-why` p95 is the slowest route and the only one with no client timeout — 9.3 s at the
  incumbent, before any migration.

## Where the sequence stands

Task 5's gate is **not passed** and the plan says a failed gate stops the sequence rather than
redefining the bar. Tasks 6's flips stay blocked until this is decided. The frozen set
(`evaluation/results/route-freeze-routes-v1.json`, gitignored) is reusable and should be, so a fixed run
can be compared against this one on the same documents.
