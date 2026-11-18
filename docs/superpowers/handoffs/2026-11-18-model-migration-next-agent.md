# Handoff: continue the model-config / GPT-6 migration

**Written:** 2026-11-18 by the session that executed plan Tasks 1–5. **Supersedes**
`2026-11-18-model-config-handoff.md` for state — that one is still worth reading for history.

## Read first, in this order

1. `docs/superpowers/plans/2026-11-18-qa-sweep-and-migration-stages.md` — the active plan. It carries its
   own corrections: Task 4 is PARTIAL, Task 4b is defined and done, Task 5 is blocked.
2. `docs/superpowers/specs/2026-11-12-model-config-and-gpt6-design.md` — binding. §0 first (refactor,
   probe, migration are separate and in that order).
3. `docs/superpowers/handoffs/2026-11-18-qa-baseline-models.md` — what QA actually runs, measured.
4. `docs/superpowers/handoffs/2026-11-18-route-sweep-first-run-findings.md` — why Task 5 stopped.
5. `docs/superpowers/reviews/2026-11-18-plan-premise-check.md` — the audit whose findings shaped the plan.
6. `.superpowers/sdd/2026-11-18-qa-sweep-and-migration-stages/progress.md` — **every `Ruling:` line**.
   These are decisions already taken; do not relitigate them, and do not silently reverse one.

## Where the work is

- Repo `/Users/davidgutelius/dev/askwrimvp`, worktree `/Users/davidgutelius/dev/askwrimvp/.worktrees/model-config`
- Branch `feat/model-migration`, **17 commits on `origin/qa`, NOT PUSHED**, tip `b4a715d`
- Baseline: `origin/qa` = `6ad67fc` (merges of #486 then #485 — both are deployed to QA)
- Everything is committed; the working tree is clean. `.env` in that worktree holds a working OpenAI key.
- Gates on the tip: **1290 tests pass** (22 DB suites skip without `DATABASE_URL`), lint clean, prettier
  clean, `next build --webpack` exit 0. Every commit reviewed by the post-commit roborev hook; **open
  failing jobs: 0**.

## What is done and true

- **The app tier's model config is one place.** `src/config/models.ts` holds models, capability, tier,
  price, `ASSIGNMENT`, `TASK_EFFORT`, `TASK_EVIDENCE`, `EMBEDDERS`, and `resolveModel(task)`. Every
  `OPENAI_MODEL*` read is gone; `MODEL_<TASK>` is the only lever, validated, throwing on an unknown or
  effort-illegal id.
- **`ASSIGNMENT` is measured, not inferred:** answer/translate → `gpt-5.4-mini`; why/relates/alignment →
  `gpt-5.4-nano`; prefilter → `gpt-5.4-nano` (unobservable: `USE_NANO_FILTER` is off). Five of six code
  defaults were wrong before this work.
- **The GPT-6 request arm exists and is inert.** For a reasoning model: `max_completion_tokens` at the
  task's effort, no temperature, the task's evidence budget. Capability comes from the requested model,
  effort and budgets from the task. No assignment names a candidate, so no request has changed.
- **Cost and energy read the registry.** `costs.ts` throws on an unknown model instead of borrowing
  `gpt-4o-mini`'s rate; `energy.ts` keys factors on the registry tier; `topicsAdmin` and `utils.tsx` derive
  from registry ids. `EMBEDDERS.active = cohere-embed-v4` at $0.12/1M input.
- **The sweep produces the bar's numbers.** `evaluation/route-sweep/report.ts`: p95 with n, cost per route
  per model, and `acceptanceGate`, which fails on unmeasured cost, >20% cost delta, a missing route/model
  pair, and a zero or empty baseline. The CLI reports acceptance separately from the mechanical checks.

## What is blocked, in order

**1. `batch-why` degradation (blocks everything).** The first live sweep (80 calls on the frozen
`routes-v1` set) failed twice, both `batch-why`:
- `q8` on `gpt-5.4-nano` — parse error at char 759 → six canned explanations. **That is the model QA runs
  today**, so this is live.
- `q5` on `gpt-5.4-mini` — 2 of 26 explanations substituted with canned text (`sanitized: true`).
The artifact records the sweep's payload, not the provider body, so `finish_reason` is invisible:
truncation and malformed output look identical. **Cheapest next step:** the `why` budget is
`min(200 + 80 × passages, 3000)` (680 tokens at 6 passages) and the GPT-5.4 family spends reasoning
tokens out of the same budget; run `npm run probe:models -- --task why --models gpt-5.4-nano` (records
`finish_reason`) or add a passages knob to the probe fixture so it matches the failing shape. Do **not**
fix the route ad hoc — write the fix plan first.

**2. A clean sweep.** Once 1 is understood: `EVAL_MODEL_OVERRIDE_TOKEN=qa-route-sweep npm run
eval:routes -- --stage sweep --label routes-v1 --model-a gpt-5.4-nano --model-b gpt-5.4-mini` and read the
readout. The frozen set is at `evaluation/results/route-freeze-routes-v1.json` (gitignored; reuse it,
do not refreeze).

**3. Deploy this branch to QA.** It is behaviour-neutral — `ASSIGNMENT` now equals the measured baseline
— but that claim is only proven by, after the deploy, one unoverridden request per route reporting the
same `provenance.model` as `2026-11-18-qa-baseline-models.md`. Nobody has run that check yet.

**4. Task 6, the five flips** — translate → why → relates → alignment (+ delete the `tools` rung) → answer
with prefilter. One line of `ASSIGNMENT` each, one PR each, each gated on a candidate-vs-incumbent sweep
plus the acceptance bar. Two things will bite:
- **Cost.** `gpt-5.4-mini` already runs +201% to +243% over nano per route; the bar allows +20%. Answer
  synthesis on Sol will be far above nano.
- **The alignment ladder.** A GPT-6 id takes the *shorter* ladder (20 000/12 000) than the gpt-5
  incumbents (40 000/25 000), so that flip tightens its own deadline. The ladder now follows the model
  actually called, so the pre-flip sweep measures the post-flip deadline — read the p95 against the
  shorter base.

**Out of scope for this plan:** the ingestion worker and `search-service` (own deployment, own registry
mirror, cross-language fixture), the stale-env cleanup, answer-eval baselines.

## Non-negotiables

- **Read `roborev job list` after every commit, and read *every* job for a SHA** — the hook has produced
  two jobs per commit, and once they disagreed (932 Pass, 931 Fail on the same sha). A `Fail` verdict
  means the task is not finished, however green the suite. Fix, comment, close. Never `--no-verify`.
- **Run gates with `.env` moved aside** (`mv .env /tmp/x && … && mv /tmp/x .env`); with it present 26 DB
  suites hit RDS and fail. CI has no `.env`. Exception: `npm run probe:models` reads it.
- **`npx next build --webpack` fails once** with Next's own `SecurityFatalError` and passes on retry.
  Never run `next upgrade` — that is the operator's call.
- **No model flips without the bar** (probe ✓, clean sweep, p95 < 60% of the deadline where one exists,
  cost within 20%, human read of the side-by-side). A missed bar stops the sequence; it never gets
  redefined.
- **Never push `main` or `production`.** `qa` deploys on any push. Use **merge commits**, not squash: the
  next branch is stacked on top of `qa` and a squash re-shows every file.
- **The sweep token is public** (`EVAL_MODEL_OVERRIDE_TOKEN=qa-route-sweep` in `terraform/environments/qa.tfvars`).
  It bounds accidents only.

## Process the operator requires

- **No implementation without a written plan** (`superpowers:writing-plans`), with the design as the
  binding authority. If the spec and the code disagree, the code is wrong until proven otherwise.
- **Implement with `superpowers:executing-plans` or `subagent-driven-development`.** Record every
  deviation from the plan as a `Ruling:` line in the SDD ledger, with what it costs if wrong.
- **Every step is TDD**: the failing test first, watched failing for the right reason.
- **Reviews run on codex with `gpt-6.1-sol` (whole-branch, write access) and `gpt-6-luna` (fast delta
  reviews).** Both follow the superpowers process. Their findings have real value: `gpt-6.1-sol` found
  that `reasoning_effort` was never serialized and that a results-page load would crash;
  `gpt-6-luna` found that the acceptance gate passed on an empty artifact. My own tests were blind to
  both.
- **A reviewer's severity label is advice.** Re-grade by effect: what does a reasonable person using this
  software get if it ships.

## Open questions for the operator

1. Push `feat/model-migration` and open the PR to `qa` now, or hold until the sweep is clean? (It is
   inert either way; pushing gets the levers, registry and accounting live.)
2. Task 5's fix plan: probe-first (one call, records `finish_reason`) or record `finish_reason` in
   `batch-why`'s fallback debug as the standing instrumentation?
3. Whether the answer-synthesis flip is even worth attempting on cost grounds once the numbers exist.
