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

## Probe on the candidate, 2026-11-18

`gpt-5.4-*` is retired, so the probe ran on the model this route is moving to:
`npm run probe:models -- --task why --models gpt-6-luna` (25-passage fixture, budget 2200).

| Effort | Latency | in / out | reasoning | Verdict |
|---|---|---|---|---|
| medium | 10.6 s | 1707 / 947 | 57 | usable |
| none | 6.6 s | 1707 / 805 | 0 | usable |

Output sits at 36–43% of the budget, and `none` spends no reasoning tokens, so the truncation hypothesis
does not reproduce on Luna. A 6-passage reply is roughly a quarter of this size. No budget change is
indicated; the route now records `finish_reason` (`b2a6229`) and names a cut-off `truncated`, so a
recurrence is distinguishable on the next sweep. Caveat: the probe prints `usable`, not `finish_reason`
itself, and the failing 6-passage shape was not run.

## Second sweep: incumbent vs the candidate, 2026-11-18

After #489 deployed (live image `24338bd`, verified; one unoverridden request per route matched the
baseline model table). `--model-a gpt-5.4-nano --model-b gpt-6-luna`, same frozen set. Artifact
`evaluation/baselines/2026-11-18-route-sweep-routes-v1.{json,md}`; the first run is kept beside it as
`…-routes-v1-nano-vs-mini.{json,md}`.

| Route | nano p95 / cost | luna p95 / cost | Luna failed |
|---|---|---|---|
| batch-why | 8.6 s / $0.0125 | 10.7 s / $0.0045 (-64%) | 0 of 10 |
| batch-relates | 6.0 s / $0.0101 | 6.3 s / $0.0044 (-57%) | 0 of 10 |
| alignment | 2.4 s / $0.0044 | 5.6 s / $0.0028 (-38%) | 1 of 10 (sanitized, q6) |
| translate | 2.6 s / unmeasured | 3.2 s / unmeasured | 0 of 10 |

- Luna ran clean on the three routes it is the planned candidate for (why, relates, translate). The
  alignment substitution is informational: alignment's planned candidate is Terra.
- The incumbent's own `batch-why` substituted text on q6 (the failure class this work started from).
- **The gate failed three cost lines because Luna is cheaper.** The bar reads "within 20% of the
  incumbent's" (spec line 354); the implementation is symmetric. A saving is not a regression, and the
  incumbent is retired, so this wants an operator decision on the bar, not a quiet code change.
- **Translate cost was unmeasured** because the route dropped `usage`. Fixed in `45123dd`; it needs a QA
  deploy before a sweep can price translate.
- `batch-why` has no client deadline, so the p95-under-60%-of-deadline clause is unevaluable there.
  Luna's p95 is 2 s above nano's.

## Third sweep: the two candidates head to head, 2026-11-18

After #490 deployed (live image `2fd41c9`, verified; unoverridden requests still return the baseline
models, so the deploy was inert). `--model-a gpt-6-luna --model-b gpt-6.1-terra`, same frozen set, with
fast mode live on batch-why and alignment and the task efforts (why/relates/translate `none`, alignment
`low`). Artifact `evaluation/baselines/2026-11-18-route-sweep-routes-v1.{json,md}`.

| Route | Luna p95 | Terra p95 | Failed (both) |
|---|---|---|---|
| batch-why (fast) | 6.5 s | 9.4 s | 0 of 20 |
| batch-relates | 7.1 s | 15.5 s | 0 of 20 |
| alignment (fast, low) | 3.1 s | 3.3 s | 0 of 20 |
| translate | 3.5 s | 7.3 s | 0 of 20 |

- 0 of 80 calls failed: no substitutions, parse failures or wrong counts, for either model, on any route.
- Luna is faster on every route; on alignment the two are at parity once fast mode is on.
- Human read of alignment, 5 cases each: both grounded in the same passages and flag the same limits.
  Terra is slightly sharper (e.g. warns that bibliography entries are not evidence); Luna is a little more
  generic. No fabricated figures from either.
- batch-relates (7.1 s) and translate (3.5 s) do not ask for fast mode: they were not probed with it.
- Terra's cost is about 8-10x Luna's. The gate reports it; it is not the concern.

## Where the sequence stands

Task 5's gate is **not passed** and the plan says a failed gate stops the sequence rather than
redefining the bar. Tasks 6's flips stay blocked until this is decided. The frozen set
(`evaluation/results/route-freeze-routes-v1.json`, gitignored) is reusable and should be, so a fixed run
can be compared against this one on the same documents.
