# Premise check — QA sweep and migration plan

**Audited:** `docs/superpowers/plans/2026-11-18-qa-sweep-and-migration-stages.md` (rev 1, 695 lines),
against the design (`specs/2026-11-12-model-config-and-gpt6-design.md`) and the code.
**Auditor:** `codex-cli 0.167.0`, model `gpt-6.1-sol`, sandbox `read-only`, prompt kept at
`/tmp/premise-check-prompt.md`, raw output below.
**Checkout:** `.worktrees/model-config` — **stale for anything under `evaluation/`**: it predates
`dc88b5b` (#486's last fix), which is on `qa` as `dea26b4d`. Finding 3 is an artifact of that.

## Triage — what survived checking

| # | Auditor's finding | Verdict |
|---|---|---|
| 1 | `--stage freeze` needs `--model-a`/`--model-b` | **Confirmed.** The parser validates both models before it looks at `--stage` (`evaluation/run-route-sweep.ts:162`). My Task 4 Step 1 would fail on the first command. |
| 2 | The request arm must be chosen from the *requested* model, not the task | **Confirmed, with a better fix.** `requestProfile` switches on `modelCapability(model)` (`src/lib/request-profile.ts:81`), and picking the arm from the task would change what an override on an incumbent-assigned task sends. Correct split: **capability from the requested model, effort/budgets/passages from the task.** |
| 3 | `checkCall` ignores `provenance.sanitized` | **Rejected — stale checkout.** `origin/qa:evaluation/route-sweep/checks.ts:132` fails on `sanitized`; that was #486's whole last fix. |
| 4 | Probing `gpt-6.1-sol` at effort `none` is an unsupported control | **Confirmed, my error.** Sol does not support `none` (design §Constraints). Use `low` vs `medium`. |
| 5 | Task 7's "no `OPENAI_MODEL*` anywhere" test cannot pass until Task 8 | **Confirmed.** `src/config/energy.ts:96,182` still reads it. Scope the assertion, or move it to Task 8. |
| 6 | Answer synthesis has no timeout ladder; 40 s/25 s is alignment's | **Confirmed.** Neither `chatCompletion` call site in `src/app/api/answer/route.ts` (195, 438) passes a `signal`. My Task 13 claimed a ladder answer does not have. |
| 7 | The sweep has no route selector, `answer` is not a `RouteName`, and answer returns no `provenance` | **Confirmed.** `KNOWN_FLAGS` has no route flag (`run-route-sweep.ts:94`); `RouteName` is the four analysis routes (`route-sweep/types.ts:9`); `grep provenance src/app/api/answer/route.ts` is empty. My Task 13's "verify live on `/api/answer`" cannot be done as written. |
| 8 | The latency denominator is not the deadline that governed the call | **Confirmed, and worse than stated.** `resolveAlignmentConfig` gives 40 s/25 s only to `/^gpt-5/`; alignment's assignment is `gpt-4o-mini`, so the live ladder is **20 s/12 s**, and the sweep records whole-route elapsed time including recovery attempts. My hardcoded `40_000` was 2× the real budget. |
| 9 | The cost gate can pass without measuring cost | **Confirmed.** `translate` returns no `usage` (`src/app/api/translate/route.ts:150-155`); alignment reports usage per attempt inside `debug.tries[]`, so costing only the success understates spend. A `?` row is not a pass — it must block. |
| 10 | The machinery must be deployed to QA before any candidate sweep | **Confirmed.** My Tasks 6–8 ended in local commits with the first PR after the gate — so the gate would have measured the old arm on QA. |
| 11 | Task 1 verifies the desired task definition, not the tasks serving traffic | **Confirmed.** The sweep itself resolves the *running* image via `list-tasks`/`describe-tasks` (`sweep.ts:227`); my Step 2 read the service's desired ARN, which can be new while old tasks still serve. |
| 12 | The deployed incumbents are unknown, and Task 7 changes them as a side effect | **Confirmed as a risk, undecidable from the repo.** Routes give `OPENAI_MODEL*` precedence today (`batch-why/route.ts:19`), and the values arrive through a GitHub secret blob (`.github/workflows/deploy-qa.yml:197`). Replacing those reads with `MODEL_<TASK>` therefore silently moves QA onto `ASSIGNMENT`'s code defaults — a model change with no gate, in the middle of a plan whose whole premise is that no model moves unmeasured. |

## One defect this audit led me to, that it did not find

`MODELS['gpt-6*'].capability.acceptsMaxCompletionTokens` is `false` for all four candidates
(`src/config/models.ts:80-113`), but the field's comment says it means "accepts the
`max_completion_tokens` parameter", and design §3 says a GPT-6 task sends `max_completion_tokens`.
The probe — which got a usable reply on every GPT-6 case — sends exactly that
(`scripts/probe-profiles.ts:72-73`). So the registry contradicts both the design and the probe's own
evidence, and it is the field the migration arm would read. Fix before it is load-bearing.

---

## Raw auditor output

```markdown
## FALSE premises

1. **“npm run eval:routes -- --stage freeze --label routes-v1”** — plan line 306.
   - Reality: The parser requires two distinct models even for `freeze`; this command fails before retrieval, `evaluation/run-route-sweep.ts:162`.
   - Correction: `npm run eval:routes -- --stage freeze --label routes-v1 --model-a gpt-5.4-nano --model-b gpt-5-mini`.

2. **“requestProfile decides the shape from the task's resolved model … not from the requested id”** — plan line 421.
   - Reality: The current builder selects parameters from the requested model, `src/lib/request-profile.ts:81`. The binding spec preserves overrides and assigns their effort from the task, `docs/superpowers/specs/2026-11-12-model-config-and-gpt6-design.md:209`. Selecting the family arm from the assignment means a pre-flip candidate sweep receives the incumbent arm. It also changes existing override fixtures, which explicitly characterize different model arms, `src/__tests__/route-requests-unchanged.test.ts:11`.
   - Correction: Select the parameter family from the effective requested model, taking candidate effort and budgets from the task; preserve existing incumbent and eval fallback arms.

3. **“one call with provenance.sanitized = true → failed = 1”** — plan line 193.
   - Reality: `checkCall` checks production status and model identity but never checks `sanitized`, `evaluation/route-sweep/checks.ts:111`; the report explicitly treats sanitization as a caveat rather than failure, `evaluation/route-sweep/report.ts:26`. Reusing this function cannot satisfy the proposed test or zero-substitution gate.
   - Correction: Make `checkCall` reject `provenance.sanitized === true`, and update its tests and report semantics before implementing the acceptance summary.

4. **“Send the answer profile at medium and one at none to gpt-6.1-sol”** — plan line 379.
   - Reality: The binding spec excludes `none` on Sol, `docs/superpowers/specs/2026-11-12-model-config-and-gpt6-design.md:63`; the registry records that restriction, `src/config/models.ts:91`. An unsupported control cannot establish whether the supported effort was applied.
   - Correction: Compare Sol’s supported `low` and `medium` efforts, capture raw usage details, and leave effort application unverified unless provider evidence resolves it.

5. **“no source file reads an OPENAI_MODEL* variable”** — plan line 503.
   - Reality: Task 7’s proposed source scan includes `src/config`, but `energy.ts` still reads `OPENAI_MODEL` twice, `src/config/energy.ts:96`, `src/config/energy.ts:182`; those removals are scheduled for Task 8 at plan line 563. Task 7’s required test cannot pass after only its specified changes.
   - Correction: Run the repository-wide no-`OPENAI_MODEL*` assertion after Task 8 removes the remaining energy reads.

6. **“its timeout ladder … (40 s main / 25 s repair, scaled and clamped to 60/50 s)”** — plan line 679.
   - Reality: That ladder belongs to alignment, `src/lib/alignment-config.ts:19`, `src/app/api/alignment/route.ts:478`. Answer synthesis makes one `chatCompletion` call without a signal, `src/app/api/answer/route.ts:441`; the client supplies no timeout unless its caller supplies a signal, `src/lib/llm/chat-completions.ts:77`.
   - Correction: Answer synthesis currently has no caller-supplied client timeout or repair ladder; establish its own measured deadline before applying the spec’s latency gate.

## UNVERIFIED premises

1. **“--model-a gpt-4o-mini … route batch-why”** as the incumbent comparison — plan line 616; likewise relates/alignment at lines 631/647.
   - Reality: These are registry defaults, `src/config/models.ts:119`, but current routes give deployed environment values precedence, `src/app/api/batch-why/route.ts:19`, `src/app/api/batch-relates/route.ts:15`, `src/app/api/alignment/route.ts:28`. The workflow injects an external secret blob, `.github/workflows/deploy-qa.yml:197`; its values are unavailable in this checkout. Task 7 can therefore change the running incumbent before any named flip.
   - Correction: Record each route’s effective incumbent before retiring old levers, preserve it through that rollout, and use the observed incumbent in its comparison.
   - decides it: Make one unoverridden request per route before and after Task 7 and inspect provenance; inspect only the relevant model keys in the running task environment if the selections differ.

## Ordering and gate findings

**The shared gate does not measure the job being flipped.** Plan lines 579–588 always run all four sweep routes; the CLI has no route selector, `evaluation/run-route-sweep.ts:94`, and passes the complete fixed route list, `evaluation/run-route-sweep.ts:421`. Thus unrelated routes can veto a single-job migration. Answer is absent from `RouteName`, `evaluation/route-sweep/types.ts:9`, and Task 13 provides no answer candidate capture. The pre-filter uses its own `NANO_MODEL`, `src/app/api/answer/route.ts:191`, and runs only when `USE_NANO_FILTER` is enabled, whose default is false, `src/app/api/answer/route.ts:26`. Answer also returns no provenance, `src/app/api/answer/route.ts:607`, so line 676’s verification cannot succeed. Add job-specific capture and provenance for both answer and pre-filter before either flips; batch-why’s shape cannot satisfy their acceptance bar at `docs/superpowers/specs/2026-11-12-model-config-and-gpt6-design.md:352`.

**The latency denominator is not the deadline that governed the measured call.** Plan lines 221–226 hardcode alignment to 40,000 ms. Its actual bases depend on model capability and environment, `src/lib/alignment-config.ts:19`, and the route scales and clamps them per request, `src/app/api/alignment/route.ts:478`. For the registry’s current alignment assignment, the non-GPT-5 ladder applies, `src/config/models.ts:123`. The sweep records whole-route elapsed time, potentially including recovery attempts, `evaluation/route-sweep/sweep.ts:111`; a base timeout is neither that whole-route budget nor the actual primary deadline. Record effective attempt deadlines and durations and define a comparable job deadline. Replace plan lines 689–693’s deferral: the binding spec requires registry ownership and re-derivation from measured p95 **before any flip**, `docs/superpowers/specs/2026-11-12-model-config-and-gpt6-design.md:393`, `docs/superpowers/specs/2026-11-12-model-config-and-gpt6-design.md:418`.

**The cost gate can pass without measuring cost.** Task 2 permits null costs, and lines 254–255 explicitly waive a row’s cost gate when prices cannot be sourced. Translate returns no usage, `src/app/api/translate/route.ts:155`. Alignment stores usage under each `debug.tries[]` entry, rather than a top-level usage field, `src/app/api/alignment/route.ts:521`, `src/app/api/alignment/route.ts:581`, `src/app/api/alignment/route.ts:627`; costing only the successful attempt omits earlier spend. Define route-specific extraction, sum every billed alignment attempt, expose translate usage, and make missing price/usage block migration. A `?` cannot satisfy the binding cost bar, `docs/superpowers/specs/2026-11-12-model-config-and-gpt6-design.md:352`.

**The migration machinery has no explicit deployment before the first candidate gate.** Tasks 6–8 end in local commits at plan lines 477, 526 and 570; the first explicit PR/merge occurs after the candidate gate, at lines 591–592. QA deploys on a push to `qa`, `.github/workflows/deploy-qa.yml:8`. The existing candidate entries deliberately retain legacy request behavior, `src/config/models.ts:75`, so sweeping QA before deploying Task 6 measures that legacy arm. Land and verify the request-arm, resolver and accounting changes on QA before Task 9’s pre-flip sweep.

**Task 1 verifies desired service configuration rather than the tasks serving requests.** Plan lines 94–100 read the service’s task-definition ARN and its image tag. Terraform pins that desired image, `terraform/infrastructure/ecs.tf:323`, but the harness obtains actual running-task image digests separately through `list-tasks` and `describe-tasks`, `evaluation/route-sweep/sweep.ts:227`. The plan’s checks can therefore pass during replacement while older tasks still serve traffic. Require service stability and verify every serving task’s task-definition revision and image digest against the intended deployment before recording its identity or sweeping.

## What is already right

- QA deployment plans with `qa.tfvars` and applies the saved plan, `.github/workflows/deploy-qa.yml:200`, `.github/workflows/deploy-qa.yml:211`.
- QA declares the public sweep token and ECS includes app environment variables, `terraform/environments/qa.tfvars:40`, `terraform/infrastructure/ecs.tf:426`.
- Overrides require an enabled token and matching request header, `src/lib/route-model.ts:24`.
- Freeze does not require a token, `evaluation/run-route-sweep.ts:187`.
- Zero-document frozen cases are skipped, `evaluation/route-sweep/sweep.ts:160`.
- Array output counts derive from request inputs, `evaluation/route-sweep/checks.ts:72`.
- Sweep artifacts record requests, responses and whole-call latency, `evaluation/route-sweep/sweep.ts:102`.
- Frozen sets are keyed by label under the ignored results directory, `evaluation/run-route-sweep.ts:228`, `.gitignore:79`.
- Incumbent `gpt-5.4` and `gpt-5.4-nano` registry entries lack prices, `src/config/models.ts:59`.
- Unknown cost models currently fall back to the gpt-4o-mini rate, `src/config/costs.ts:13`.
- The probe reads reasoning-token details and distinguishes API acceptance from usability, `scripts/probe-models.ts:216`, `scripts/probe-models.ts:232`.
- Characterization tests compare raw outbound JSON strings, `src/__tests__/route-requests-unchanged.test.ts:85`.

```
