# Handoff: model config / GPT-6 workstream

**Written:** 2026-11-18. Supersedes the earlier handoff in this directory for anything about
state; read this one first.

## Where the work stands

Two branches, both pushed, both open as PRs against `qa`.

| | branch | tip | PR | state |
|---|---|---|---|---|
| 1 | `feat/route-model-sweep` | `dc88b5b` | **#486** (ready) | code complete, CI to confirm |
| 2 | `feat/model-config-gpt6` | `ac0aa5c` | **#485** (draft, stacked on #486) | stage 1 complete, CI to confirm |

Worktree for branch 2: `.worktrees/model-config` (has a gitignored `.env` with a working
OpenAI key). Branch 1 can be checked out in the main checkout.

## What is actually proven, and what is only claimed

Read this before believing any PR description.

**Proven**
- `#486`: `npm run test:ci` 1240 passed / 0 failed (DB suites skip without `DATABASE_URL`);
  `npx next build --webpack` exit 0. The four routes carry `provenance` on every return path;
  a rejected override is a 400; QA gets `EVAL_MODEL_OVERRIDE_TOKEN`, production does not.
- `#485`: `npm run test:ci` 1243 passed / 0 failed; `next build` exit 0; lint and format clean.
  The raw-body characterization tests still pass **after** the routes were rewired to read
  `ASSIGNMENT` — that is the only evidence that the rewiring is behaviour-neutral.
- Probe run once against the real API: 7/7 cases accepted and usable (gpt-6.1-sol answer
  `medium` 4.5 s; gpt-6.1-terra alignment both shapes `medium` ~4–5 s; gpt-6-luna
  why/relates/translate/prefilter `none`, `why` slowest at 7.1 s). **We have GPT-6.1 access on
  the app's key.**

**Not proven — do not assume**
- The sweep tool has **never run against a deployed QA**. Not once.
- The probe's verdicts were tightened twice after that run (shape checks, `finish_reason`,
  array/object dispatch). The 7/7 table predates the tightening; re-run it.
- `reasoning=0` was reported for the answer profile at `medium` despite 4.5 s. Unexplained:
  either the usage block omits reasoning detail or effort is not applied. Until that is
  resolved, effort-cost estimates are guesswork.
- One timing sample per profile is not a latency baseline.

## Landmines that will waste your time if unknown

1. **`next build` fails once, then passes.** Next halts with
   `SecurityFatalError: Your version of Next.js is affected by a known security vulnerability`
   and says to retry. The second run succeeds. Do not treat the first failure as ours.
   (It also asks, once, whether to run `next upgrade --agent=security`; that is the
   operator's call, not yours.)
2. **Run gates with no `.env` present.** With `.env` in place, `DATABASE_URL` is defined, the
   DB suites stop skipping and try to reach RDS: 26 red suites. CI has no `.env`. Move it
   aside, run, move it back.
3. **A `roborev` pre-push hook refuses pushes with open review findings.** It is not optional
   noise: on `#486` it found the substitution false-pass, and on `#485` it found two real
   bugs in the fix for it. Use `roborev compact` to re-validate, then `roborev job show --job
   N`, fix, `roborev job comment` + `roborev job close N`. Only the operator authorises
   `--no-verify`.
4. **`ResultsPage.test.tsx` fails under full-suite parallelism** at the base commit too — a
   jsdom checkbox race, not ours. `--maxWorkers=2` and CI's `--runInBand` are green.
5. **`anthropic/*` models were unusable** in this environment (OAuth refresh returned
   `invalid_grant`). Implementers ran on `lunaroute/deepseek-4.1-flash`, reviewers on
   `lunaroute/glm-5.3`. Re-check before dispatching.
6. The compiled `next build` output leaves `.next/standalone/` copies that Jest will collect if
   you override `testPathIgnorePatterns` on the command line. Leave the config alone.

## The next actions, in order

1. **Get #486 green and merged.** It is the blocker; nothing else advances until it lands.
   Its CI must pass. Merging to `qa` deploys QA — that is the intended sequence here, and it
   is the first time the override token exists in a deployed environment.
2. **Re-target #485 onto `qa`** once #486 merges (it currently shows 44 files only because it
   is stacked; it shrinks to the registry work). Merge it. That makes `ASSIGNMENT` live.
3. **One recorded live sweep**, incumbent models unchanged, against QA:
   `npm run eval:routes -- --label smoke --model-a <incumbent> --model-b <incumbent>`. Review
   **every** substitution and skipped case. This is the first end-to-end run of the harness and
   the gate the whole staged plan depends on. Expect to fix the harness.
4. **Re-run the probe** now that its verdicts are strict, and resolve `reasoning=0`.
5. Only then begin the migration, per the design's sequence and acceptance bar:
   translate → why → relates → alignment → answer synthesis last. Pricing tables
   (`costs.ts`, `energy.ts`, `topicsAdmin.ts`, `utils.tsx`) must read the registry before any
   task flips, or the cost figures lie.

## Process — required, not optional

The next session works **under the superpowers process**, because this workstream drifted when
it did not:

- **No implementation without a written plan.** The next unit of work (the live sweep + the
  migration stages) needs `superpowers:writing-plans` first, with the design as the binding
  authority (`docs/superpowers/specs/2026-11-12-model-config-and-gpt6-design.md`).
- **Implement with `superpowers:executing-plans` or `superpowers:subagent-driven-development`**,
  not ad hoc. Task-scoped review between tasks.
- **Spec first, then plan, then code.** If the spec and the code disagree, the code is wrong
  until proven otherwise — twice in this workstream the docs claimed behaviour the code did not
  have, and once the design's own sentence ("no English control case") shipped as a hardcoded
  falsehood.
- **The acceptance bar in the design is the gate**, not green CI: probe ✓ for the task's shape,
  ten-case capture with zero fallbacks and zero substitutions, p95 under 60% of the deadline,
  cost within 20%, and a human read of the side-by-side.
- Keep `roborev` findings in the loop; they caught three real defects this session.

## Loose ends outside this workstream

- Five other open draft PRs (`#458`, `#440`, `#439`, `#426`, and #485 until it lands) — not
  ours, untriaged.
- `feat/route-model-sweep`'s SDD ledger and review reports were preserved at
  `/tmp/route-model-sweep-sdd/` before its worktree was removed.
