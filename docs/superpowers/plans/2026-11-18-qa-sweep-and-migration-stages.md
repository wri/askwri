# QA Route Sweep and Model Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the route sweep produce the numbers the design's acceptance bar asks for, run it against
deployed QA, then move one job at a time to the GPT-6 class — each move gated on a candidate-vs-incumbent
sweep, never on green CI.

**Architecture:** Phase A learns what QA actually runs and makes the lever swap behaviour-neutral, adds the
reasoning request arm (inert until a task is assigned a candidate), and gives the readout the two numbers
the bar needs. Phase B is one recorded sweep of the harness, then five flips of one `ASSIGNMENT` line each.

**Tech Stack:** TypeScript, tsx, Jest (`@jest-environment node`), Next.js 16, `evaluation/route-sweep/`, ECS.

**Spec:** `docs/superpowers/specs/2026-11-12-model-config-and-gpt6-design.md` (§0 is binding: refactor,
probe and migration are separate, in that order).
**Prior evidence:** `docs/superpowers/reviews/2026-11-18-plan-premise-check.md` — the audit this plan is
rewritten from. Every finding it lists is either fixed here or the reason it is not.

## Global Constraints

- **The bar is the gate.** Per job: probe ✓ at that job's effort; a sweep with zero failed checks on
  that job's routes and zero substitutions; every output length matching the input count; p95 under 60%
  of that job's configured deadline; cost within 20% of the incumbent's; a human read of the readout.
- **Nothing may flip before Task 4 lands.** Cost figures from the old tables are numbers about a
  different model.
- **Run gates with `.env` moved aside** (`mv .env /tmp/x && … && mv /tmp/x .env`): with it present the DB
  suites stop skipping and fail against RDS. CI has no `.env`. Exception: `npm run probe:models` reads it.
- **`npx next build --webpack` fails once** with Next's own `SecurityFatalError` and passes on retry. Never
  run `next upgrade`; that is the operator's call.
- **Never bypass roborev,** and never push `main`/`production`. QA deploys on any push to `qa`.
- **Read `roborev job list` after every commit, not only at push time.** The post-commit hook reviews
  each commit and stores findings that block the pre-push gate; a `Fail` verdict on any commit of the
  branch is a task that is not finished, however green the suite is. (Plan defect, found the hard way:
  two High findings sat unread through three "complete" tasks.)
- **Model ids:** `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`. `none` effort is legal only
  on Terra and Luna. All four accept `max_completion_tokens` (probe-verified, see #485's `2773071`).
- **Two sweeps on one day at one label overwrite each other.** Copy an artifact aside first.

## Review Focus

The five ways this produces confident nonsense. Each gets a test in the task beside it.

1. **A lever swap that silently moves the model QA runs.** Routes take `OPENAI_MODEL*` from a GitHub secret
   blob today (`batch-why/route.ts:19`, `deploy-qa.yml:197`); replacing those reads with `MODEL_<TASK>`
   puts QA on `ASSIGNMENT`'s code defaults. Task 2's "assignment equals what QA runs" test.
2. **A candidate arm that sends the incumbent's parameter family.** `max_tokens` to a reasoning family is
   the request most likely to be refused, and it would read as a capability failure. Task 3.
3. **A sweep that reports clean over no evidence** — every frozen case retrieved nothing, or `checks: 0 of
   0` with exit 0. Task 5's roster step and Task 4's `n`-beside-every-percentile rule.
4. **A gate that passes with cost unmeasured.** `translate` returns no `usage`; alignment bills every
   failed attempt inside `debug.tries[]`. A missing number must block, not print `?`. Task 4.
5. **A gate for a job the harness cannot measure.** `/api/answer` returns no `provenance`; the pre-filter
   only runs when `USE_NANO_FILTER=true` (`answer/route.ts:25`, default false). Task 6's prerequisites.

---

### Task 1: What QA runs today

The deployed model per route is not in this repo: it arrives through `ASKWRI_APP_ENV`
(`.github/workflows/deploy-qa.yml:197`). Every gate below needs it as `--model-a`, and Task 2 cannot be
behaviour-neutral without it.

**Files:** none. Creates a recorded table that Tasks 2, 5 and 6 read.

**Interfaces:**
- Produces: for each of `batch-why`, `batch-relates`, `alignment`, `translate` — the model id QA used, in
  `docs/superpowers/handoffs/2026-11-18-qa-baseline-models.md`.

- [ ] **Step 1: Confirm the deploy that landed #486 is the one serving**

QA's deploy for `dea26b4d` succeeded. The sweep resolves the image from *running* tasks
(`sweep.ts:227`), so do the same, after the service reports `runningCount == desiredCount`:

```bash
SVC=askwri-app-qa-service; CL=askwri-app-qa-cluster; R=us-east-2
aws ecs describe-services --cluster $CL --services $SVC --region $R \
  --query 'services[0].{d:desiredCount,r:runningCount,td:taskDefinition}'
aws ecs list-tasks --cluster $CL --service-name $SVC --region $R --query 'taskArns' --output text \
  | tr '\t' '\n' | xargs -n1 -I{} aws ecs describe-tasks --cluster $CL --tasks {} --region $R \
      --query 'tasks[0].containers[0].image' --output text
```

Expected: one distinct image whose tag is `dea26b4d` (or the merge commit's sha). Two different images
means a roll is in progress — wait.

- [ ] **Step 2: One unoverridden call per route, and read back the model it used**

The body names it: `translate` returns `model`; `batch-why`/`batch-relates` return `usage.model`;
`alignment` returns `debug.tries[-1].usage.model` as `openai/<id>`. Send each route one request with **no**
`model` field (payload shapes: `evaluation/route-sweep/payloads.ts`; a `--limit 1` freeze gives you the
documents). Record the stripped id per route.

- [ ] **Step 3: Confirm the sweep gate is live on the new deploy**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://qa.askwri-app.org/api/translate \
  -H 'content-type: application/json' -H 'x-eval-token: wrong' -d '{"text":"Hola"}'
curl -s -X POST https://qa.askwri-app.org/api/translate -H 'content-type: application/json' \
  -H 'x-eval-token: qa-route-sweep' -d '{"text":"Hola","model":"gpt-5-mini"}' \
  | jq -c '{ok,model,provenance}'
```

Expected: `400`, then `200` with `provenance.produced == true`.

- [ ] **Step 4: Write the table and commit**

```bash
git add docs/superpowers/handoffs/2026-11-18-qa-baseline-models.md
git commit -m "docs(superpowers): what QA actually runs, per route"
```

---

### Task 2: The lever swap moves nothing

Spec §9 renames the levers so stale values become inert. That is only safe if the registry already holds
what the deployed values say — otherwise the rename is an ungated model change.

**Files:**
- Modify: `src/config/models.ts` (add `resolveModel`, correct `ASSIGNMENT`), `src/config/energy.ts:96,182`,
  `src/config/alignment.ts:5`, `src/lib/answer-synthesis.ts:3`,
  `src/app/api/{batch-why,batch-relates,alignment,translate,answer}/route.ts`
- Test: `src/__tests__/models-registry.test.ts`

**Interfaces:**
- Produces: `resolveModel(task: TaskId): ModelId` — reads `MODEL_<TASK>` (`MODEL_ANSWER`, `MODEL_PREFILTER`,
  `MODEL_WHY`, `MODEL_RELATES`, `MODEL_ALIGNMENT`, `MODEL_TRANSLATE`); a value the registry does not
  describe throws at module load; absent → `ASSIGNMENT[task]`.

- [ ] **Step 1: Write the failing tests**

```ts
it('assigns each task the model QA actually runs', () => {
  // The table from Task 1, pinned. A flip edits one line here and the test, together.
  expect(ASSIGNMENT).toEqual({ answer: '…', prefilter: '…', why: '…', relates: '…',
    alignment: '…', translate: '…' })
})
it('resolves a task from its lever', ...)              // MODEL_WHY=gpt-6-luna → 'gpt-6-luna'
it('throws on an id the registry does not describe', ...)  // MODEL_WHY=gpt-4-turbo → /unknown model/
it('no file reads an OPENAI_MODEL* variable', ...)     // scan src/ — energy.ts's two reads are this task
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/__tests__/models-registry.test.ts -t 'QA actually runs'`
Expected: FAIL — `ASSIGNMENT` still holds the code defaults.

- [ ] **Step 3: Correct `ASSIGNMENT`, implement `resolveModel`, delete the env reads**

`energy.ts`'s two `OPENAI_MODEL` reads go here, not later: they are the last id readers, and the scan test
cannot pass while they exist. `answer-synthesis.ts` and `alignment.ts` take the id as an argument.

- [ ] **Step 4: Run the new tests plus the characterization suite**

Run: `npx jest src/__tests__/models-registry.test.ts src/__tests__/route-requests-unchanged.test.ts`
Expected: PASS with **no fixture edited**. A changed fixture means the swap moved a request.

- [ ] **Step 5: Gates and commit**

With `.env` aside: `npx jest --maxWorkers=2`, `npm run lint`, `npm run format:check`,
`npx next build --webpack` (retry once). Then:

```bash
git commit -m "feat(models): MODEL_<TASK> levers, on the ids QA already runs"
```

---

### Task 3: The reasoning arm

Spec §3: a task on the GPT-6 class sends `max_completion_tokens`, `reasoning_effort` from the task, no
`temperature`, and takes its passage budget from the task. **Capability comes from the requested model,
effort and budgets from the task** — the override keeps its own arm (spec §3, "the override still wins"),
and picking the family from the assignment would silently change what an override on an incumbent sends.

**Files:**
- Modify: `src/lib/request-profile.ts`, `src/lib/route-model.ts`, `src/config/alignment.ts`
- Test: `src/__tests__/models-registry.test.ts`, `src/__tests__/alignment-route.test.ts`

**Interfaces:**
- Produces: `isReasoning(model)` = the registry spec says `acceptsMaxCompletionTokens` and not
  `gpt5Class` — the arm is `{ maxCompletionTokens, reasoningEffort }`, temperature omitted.
  `resolveRouteModel` drops its `isGpt5` flag; the alignment deadline ladder reads the **task's**
  capability (`resolveAlignmentConfig(resolveModel('alignment'))`), keeping its scaling and clamps.

- [ ] **Step 1: Write the failing tests**

```ts
it('sends the reasoning arm for a candidate: no temperature, task effort, task budget', ...)
  // translate assigned 'gpt-6-luna' → { maxCompletionTokens: 2000, reasoningEffort: 'none' }
it('refuses an override that cannot run the task effort', ...)
  // alignment (medium) overridden with 'gpt-6-astra' → 400 naming model and effort
it('keeps each incumbent arm byte-identical', ...)   // the characterization suite, untouched
it('derives alignment deadlines from the task, not the overriding id', ...)
  // assignment 'gpt-4o-mini' + override 'gpt-6.1-terra' → still 20 000/12 000; and the
  // large-prompt clamp still applies
```

- [ ] **Step 2: Run to verify they fail, then implement**

Run: `npx jest src/__tests__/models-registry.test.ts -t 'reasoning arm'`

- [ ] **Step 3: Characterization suite, gates, commit**

Run: `npx jest src/__tests__/route-requests-unchanged.test.ts` — PASS, no fixture edited. Then the gate set
from Task 2 Step 5.

```bash
git commit -m "feat(models): a reasoning request arm, inert until a task is a candidate"
```

---

### Task 4: Prices from the registry, and the bar's two numbers

> **Status 2026-11-18: PARTIAL, and wrongly marked complete.** The prices and the readout landed
> (`e372b11`, plus the acceptance gate in `e2981f6`); the consumer files this task names —
> `src/config/costs.ts`, `src/config/energy.ts`, `src/db/queries/topicsAdmin.ts`,
> `src/app/utils/utils.tsx` — did **not** get touched. `costs.ts` still prices any unknown model at
> `gpt-4o-mini`'s rate, which now includes both assigned incumbents. Raised by the whole-branch review
> (gpt-6.1-sol, finding 5). Split out as **Task 4b**, which must land before Task 6's first flip:
> it needs registry entries that do not exist yet (an embedder id with its price, and a `tier` for
> energy's factors).

The bar asks for p95 and cost. Nothing computes either, `costs.ts` prices unknown models at
`gpt-4o-mini`'s rate, and the registry holds no price for the ids Task 1 found.

**Files:**
- Modify: `src/config/models.ts` (prices), `src/config/costs.ts`, `src/config/energy.ts`,
  `src/db/queries/topicsAdmin.ts`, `src/app/utils/utils.tsx`, `evaluation/route-sweep/report.ts`
- Test: `src/__tests__/models-registry.test.ts`, `evaluation/__tests__/route-sweep-report.test.ts`

**Interfaces:**
- Produces: `summarise(artifact): RouteSummary[]` in `report.ts`, rendered into the existing readout —
  per route and model: `calls`, `failed`, `p95Ms`, `deadlineMs`, `costUsd`. No second entry point; the
  numbers land in the file a human already reads.

- [ ] **Step 1: Write the failing tests**

```ts
it('prices every model in ASSIGNMENT', ...)                  // after step 2 fills the gaps
it('throws on an unregistered model rather than defaulting', ...)   // costs.ts
it('prints n beside every percentile', ...)                   // renderAcceptance contains 'n=5'
it('leaves cost null when a route reports no usage', ...)     // translate
it('sums every alignment attempt, not only the successful one', ...)  // debug.tries[].usage
it('prices by the requested model, not usage.model', ...)     // alignment's 'openai/' prefix
```

- [ ] **Step 2: Fill the prices for the ids Task 1 recorded**

List prices, short-context band, from OpenAI's pricing page; record the lookup date in the comment. If one
cannot be sourced, **leave it absent and let the cost gate block** — never substitute a rate.

- [ ] **Step 3: Implement, run, gates, commit**

Run: `npx jest src/__tests__/models-registry.test.ts evaluation/__tests__/route-sweep-report.test.ts`

```bash
git commit -m "feat(models): registry prices, and p95 and cost in the sweep readout"
```

---

### Task 4b: The cost and energy consumers read the registry

Split out of Task 4 on 2026-11-18 (whole-branch review, gpt-6.1-sol, finding 5). Task 4 named these four
files and none were touched: `costs.ts` still prices every unknown model at `gpt-4o-mini`'s rate, which
now includes both assigned incumbents, so every cost figure the app shows for them is wrong.

**Files:**
- Modify: `src/config/models.ts` (an embedder entry with its price; a `tier` on every model),
  `src/config/costs.ts` (prices from the registry, `<id>` or `openai/<id>`, **throw** on unknown),
  `src/config/energy.ts` (factors keyed by registry `tier`, no env fallback),
  `src/db/queries/topicsAdmin.ts` (per-document cost from the model that writes summaries),
  `src/app/utils/utils.tsx` (the active embedder, not `text-embedding-3-small`)
- Test: `src/__tests__/models-registry.test.ts`

**Interfaces:**
- Produces: `estimateCostUSD(usage)` throws on an unregistered model instead of defaulting.

- [ ] **Step 1: Source the two missing registry facts.** The embedder id the search service writes
  (`cohere-embed-v4`, per `docs/model-inventory-and-migration.md`) with its price, and a `tier` for each
  model (design §1: flagship / balanced / fast / volume). Prices are list prices, with the lookup date in
  the comment; if one cannot be sourced, leave it absent so the gate blocks rather than guessing.
- [ ] **Step 2: Write the failing tests** — a registry model priced at the registry rate; `openai/` prefix
  accepted; unknown model throws; a tier exists for every model; a document priced at the worker model.
- [ ] **Step 3: Run them, implement, run them again.** Gates from Task 2 Step 5.
- [ ] **Step 4: Commit** — `feat(models): cost and energy read the registry, and an unknown model throws`.

**This blocks Task 6.** Design §4: the accounting must be sourced before any model is switched.

---

### Task 5: The first live sweep

**Files:** `evaluation/baselines/<date>-route-sweep-routes-v1.{json,md}` (written by the tool, committed).

**Interfaces:**
- Produces: the frozen set at `evaluation/results/route-freeze-routes-v1.json` (gitignored) that every
  later gate replays, and the committed artifact they are compared against.

- [ ] **Step 1: Freeze one retrieval set**

Both models are required even for a freeze (`run-route-sweep.ts:162`), and the freeze sends neither:

```bash
npm run eval:routes -- --stage freeze --label routes-v1 \
  --model-a <Task 1's why id> --model-b <Task 1's translate id>
```

- [ ] **Step 2: Read the roster before paying for calls**

Every case must have `docs.length > 0`. A case with none is skipped (`sweep.ts:160`), and a run over ten
empty cases prints `checks: 0 of 0` and exits 0 — the clean-looking run this tool exists to prevent.

- [ ] **Step 3: Sweep two incumbents against each other**

```bash
EVAL_MODEL_OVERRIDE_TOKEN=qa-route-sweep npm run eval:routes -- --stage sweep --label routes-v1 \
  --model-a <incumbent A> --model-b <incumbent B>
```

- [ ] **Step 4: Read the readout, then decide**

The tool sweeps all four routes; there is no route selector. A failure is either a harness defect or a
route defect, and which one it is decides the next step. **If anything failed, stop and write a fix plan**
— do not fix it inside the gate's own run. Non-negotiable part of the read: any `no provenance`,
`provenance.model is X, not the requested Y`, `not produced by a model`, `contains substituted text`,
`expected N outputs, got M`, or `output i is empty text`.

- [ ] **Step 5: Commit the artifact and the readout**

```bash
git commit -m "docs(evaluation): first live route sweep on QA, incumbents"
```

---

### Task 6: Flip one job at a time

Five flips, in this order, each its own PR. Requirements per flip: Tasks 2–3 deployed to QA, and the
job's own sweep clean.

**The gate, per flip (all three parts recorded in the PR):**

1. **Before:** `npm run eval:routes -- --stage sweep --label routes-v1 --model-a <Task 1 incumbent for
   this job> --model-b <candidate>`, then read the readout. Copy any same-day artifact aside first. Gate on
   **this job's routes only** — the tool sweeps all four, and an unrelated route must not veto a
   single-job move, though its failures are reported in the PR. Alongside it, `npm run probe:models` for
   this job's shape at its planned effort: the bar names it first, and it is the cheap half of the
   evidence. Note `reasoning=0` is still unexplained on the answer profile at `medium` despite 4.3 s
   (re-confirmed 2026-11-18 on `gpt-6.1-sol`), so effort-cost estimates stay guesswork until it is.
2. **Flip:** the `ASSIGNMENT` line plus the task's row in Task 2's pinned test. Gate set, PR to `qa`,
   operator merges.
3. **After:** one unoverridden request on the flipped route reports the candidate as the model that
   produced it. The override proves the candidate *can* run the job; only this proves the job *runs* it.

| # | Flip | Extra change | Extra check |
|---|---|---|---|
| 1 | `translate` → `gpt-6-luna` @ `none` | — | smallest surface: one string, no array to drift |
| 2 | `why` → `gpt-6-luna` @ `none` | — | **no client timeout on this route**: record p95, and say the latency clause is unevaluable rather than treating the absent deadline as headroom |
| 3 | `relates` → `gpt-6-luna` @ `none` | — | budget formula `max(1000, 120 × docs)` stays a formula |
| 4 | `alignment` → `gpt-6.1-terra` @ `medium` | delete the `tools` rung (`alignment/route.ts:545-600`) — it cannot succeed at `medium` on Chat Completions, and leaving it burns a timeout-budgeted attempt before `json_object` | ladder test: `json_schema` fails → `json_object`, exactly two calls; and the live deadline is **20 000/12 000**, not 40 000/25 000 |
| 5 | `answer` → `gpt-6.1-sol` @ `medium`, `prefilter` → `gpt-6-luna` @ `none` | **prerequisite: `/api/answer` returns no `provenance`** — add it, or the after-check cannot run; and the pre-filter runs only with `USE_NANO_FILTER=true`, so flipping it is unevidenced unless that flag is turned on for the sweep | assert the deployed body carries 15 passages × 800 chars, not the 6 × 350 arm |

A missed bar stops the sequence. The finding goes into a follow-up plan, never into a redefined bar.

## Out of scope — separate plans

- **The ingestion worker and `search-service`** (spec §10 step 5): own deployment, own registry mirror,
  cross-language fixture, legacy embedder deletion.
- **Cleanup** (spec §10 step 6): stale `OPENAI_MODEL*` keys in tfvars and `.env.example`, the
  `query_translation_model` latency comment.
- **Moving the deadline bases into the registry, and re-deriving them from measured p95.** Task 3 gives the
  ladder an owner, which is what makes `isGpt5` deletable. Moving the bases is inert motion whose only
  purpose is to be edited, and there is nothing to seed them from until a flip's p95 exists.
- **Answer-eval baselines**, the judge's move to Astra, prompt caching, the Batch API.
