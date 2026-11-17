# Handoff: model registry stage 1 (for a fresh SDD session)

**Date:** 2026-11-12
**Run this in:** `/Users/davidgutelius/dev/askwrimvp/.worktrees/model-config`, branch `feat/model-config-gpt6`
(branch base: `feat/route-model-sweep` @ `6b012e3`; that branch is **not yet merged** to `qa`)

## What to read, in this order

1. `docs/superpowers/plans/2026-11-12-model-registry-stage1.md` — the plan. Two tasks.
2. `docs/superpowers/specs/2026-11-12-model-config-and-gpt6-design.md` — the binding spec, approved.

Both are committed. Read the spec's §0 ("Refactor versus migration") first; it is the line the
plan must not blur.

## What is being built

Stage 1 only: (a) a probe that tells us whether the candidate OpenAI models are reachable and
whether they accept the request shapes we actually send, and (b) moving model ids and request
parameters behind one file, with tests proving **every request body sent upstream is
byte-identical to today's**.

**No model changes.** Every task keeps running the model it runs now. The GPT-6 switch is a
later, separate stage.

## Non-negotiables (the plan's Stage 1 invariants, abbreviated)

- No model changes; `ASSIGNMENT` holds each task's *current code default*, not what production
  runs (production's values arrive from a GitHub secret and still win).
- No request changes: raw JSON body strings, compared with `toBe`, across the ordered list of
  every outbound call — not `toEqual` on parsed objects.
- No `reasoning_effort` added, no `temperature` removed, alignment's `tools` rung kept. Those
  are migration-time changes.
- Budgets are formulas per task/attempt/input size, not one number per task.
- Alignment's timeout *scaling and clamps* are preserved, not just the 40 s / 25 s bases.
- No new env levers; no pricing assertions. Both are deferred.
- No new npm dependencies.

## Before the first dispatch

- `npm ci` in the worktree — it has no `node_modules` yet.
- Gates that matter: `npx jest`, `npm run lint`, `npm run format:check`, and
  **`npx next build --webpack`** for anything touching `src/app`. The build gate is not in the
  plan's global-checks line, and on the previous branch a non-route export from a `route.ts`
  passed tests, lint and format while failing the production image build.
- Model availability in this environment: `anthropic/*` was unusable (expired OAuth refresh,
  `invalid_grant`). Implementers ran on `lunaroute/deepseek-4.1-flash`, reviewers on
  `lunaroute/glm-5.3`. Re-check rather than assuming.

## Known landmines

- `/api/answer` shuffles passages with `Math.random()`; the prefilter fixtures must stub it or
  byte equality is nondeterministic.
- Alignment's recovery ladder is `json_schema → tools → json_object`; a first-attempt-success
  fixture exercises none of it.
- The answer route sends **no** `response_format` — it asks for JSON in the prompt. A probe built
  around structured output would be testing a request we never make.
- The answer evidence budget flips at 15 passages × 800 chars vs 6 × 350; a small fixture hides
  it.
- `evaluation/answer/judge-client.ts` keeps its own `/^gpt-5/i` mirror and is deliberately not
  wired in this stage.
- Existing route tests use `jest.resetModules()` because defaults are captured at import time.

## Loose end outside this work

`feat/route-model-sweep` (`.worktrees/route-model-sweep`, 20 commits) is complete and reviewed but
unmerged; it needs a merge/PR decision before any *model* changes, not before this plan.
