# Model Registry Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find out whether the candidate models work for us, and move model ids and request parameters behind one file — while **every request we send to OpenAI stays byte-identical to what it sends today.**

**Architecture:** Two independent tasks. A probe that runs named, real request profiles against candidate models and separates "the API accepted it" from "the output is usable". A registry that declares the known models (incumbent **and** candidate) and a request-profile builder that reproduces each route's existing payload construction — caps, temperature, schema/tool selection, omitted fields — with characterization tests comparing the **raw request body strings** before and after.

**Tech Stack:** TypeScript, Jest (`@jest-environment node`), `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-12-model-config-and-gpt6-design.md` — steps 1 and 2 of §10.

## Stage 1 invariants

Every item below is a promise this plan must keep. If an implementer cannot keep one, they report rather than proceed.

1. **No model changes.** Every task maps to the model it runs in production today.
2. **No request changes.** For each route and each documented attempt, the raw JSON body string sent upstream is identical to the pre-change body. Identical bytes, not an equivalent object.
3. **No new request fields.** `reasoning_effort` is **not** added in this stage. Today's payload builders omit it, and supplying an explicit effort — even one matching a provider default — is a behavioural change that belongs to the migration.
4. **Temperature behaviour is unchanged**, per caller. It is not removed in this stage: answer 0.3 (env-overridable), translate 0.2, prefilter 0.1, relates and alignment use their configured value, and batch-why's GPT-4o arm uses `max_completion_tokens`.
5. **Dynamic budgets stay dynamic.** Caps are per task, per attempt and per input size, and are moved as formulas — never collapsed to one scalar per task.
6. **Alignment's `tools` rung is preserved.** Deleting it is a migration decision, not a refactor.
7. **Alignment's timeout deadlines are preserved**, including the prompt-size scaling and the clamps, not just the 40 000 / 25 000 bases.
8. **No new environment levers in this stage.** `OPENAI_MODEL*` precedence stays exactly as it is today. Introducing `MODEL_<TASK>` and making the old keys inert is a separate, deliberate change.
9. **No pricing assertions in this stage.** Pricing is deferred; the registry declares prices for later use, and nothing asserts them yet.
10. No new npm dependencies. `npx jest`, `npm run lint`, `npm run format:check` pass before each commit. Branch only; never push to `main` or `production`.

## Review Focus

- **A "characterization test" that compares objects, not bytes.** `sentBody()` in the existing suites parses JSON, so `toEqual` hides serialization changes. Owned by Task 2 Step 2.
- **A fixture too small to expose the evidence-budget branch.** One document with a short snippet passes under both the 15×800 and 6×350 regimes, hiding the regression this work exists to prevent. Owned by Task 2's answer fixtures.
- **Nondeterminism making byte equality meaningless.** `/api/answer`'s prefilter shuffles passages with `Math.random()`. Owned by Task 2's prefilter fixture.
- **A first-attempt-only fixture.** Alignment's recovery ladder means a schema success never exercises the tools or json_object attempts. Owned by Task 2's alignment fixtures.
- **The probe reporting success when the output is unusable.** HTTP 200 with prose instead of JSON, or a truncated reply, is a failure for our purposes. Owned by Task 1.
- **A probe run at an effort the migration does not use.** Evidence for `low` says nothing about `medium` and `none`. Owned by Task 1's default matrix.

---

### Task 1: The compatibility probe

**Files:**
- Create: `scripts/probe-models.ts`
- Create: `scripts/probe-profiles.ts`
- Create: `scripts/__tests__/probe-models.test.ts`
- Modify: `package.json` (add `"probe:models": "npx tsx scripts/probe-models.ts"`)

**Interfaces:**
- Produces:

```ts
export type ProfileId =
  | 'answer' | 'prefilter' | 'why' | 'relates' | 'alignment.schema'
  | 'alignment.tools' | 'alignment.json_object' | 'translate'

export interface ProbeProfile {
  id: ProfileId
  /** The actual messages/schema/tools this attempt sends, built by the caller.
   *  The ceiling comes in as an argument so the probe controls the budget, and the
   *  profile controls everything else — one owner per decision. */
  body: (args: { model: string; effort: Effort; budget: number }) => Record<string, unknown>
  /** Required shape of a usable reply. */
  expect: 'json_object' | 'text'
  /** Passages/documents the profile was built from, for the record. */
  inputCount: number
}

export interface ProbeResult {
  ok: boolean                 // the API accepted the request
  usable: boolean             // the reply is non-empty, complete and the expected shape
  status?: number
  error?: string
  latencyMs: number
  finishReason?: string       // 'length' means the budget ran out: not usable
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
}

export async function probeProfile(args: {
  profile: ProbeProfile
  model: string
  effort: 'none' | 'low' | 'medium' | 'high'
  budget: number
  apiKey: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<ProbeResult>
```

Profiles are **named after the real call sites**, not generic shapes: the answer route sends no `response_format` at all (it asks for JSON in the prompt), so it is a `text` profile whose usability check is "parses as the object we expect". `alignment.schema`, `alignment.tools` and `alignment.json_object` are three separate profiles because they are three different bodies.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/__tests__/probe-models.test.ts
/** @jest-environment node */
import { probeProfile } from '../probe-models'
import { profiles } from '../probe-profiles'

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response

it('reports usable=false when a json_object profile returns prose', async () => {
  const r = await probeProfile({ profile: profiles['alignment.json_object'], model: 'gpt-6-luna',
    effort: 'none', budget: 1500, apiKey: 'k',
    fetchImpl: (async () => reply({ choices: [{ finish_reason: 'stop', message: { content: 'Sure!' } }], usage: {} })) as any })
  expect(r.ok).toBe(true)
  expect(r.usable).toBe(false)
})

it('reports usable=false when the reply hit the budget', async () => {
  const r = await probeProfile({ profile: profiles['answer'], model: 'gpt-6.1-sol', effort: 'medium',
    budget: 2000, apiKey: 'k',
    fetchImpl: (async () => reply({ choices: [{ finish_reason: 'length', message: { content: '{"sentences":[' } }], usage: {} })) as any })
  expect(r).toMatchObject({ ok: true, usable: false, finishReason: 'length' })
})

it('reports reasoning tokens separately from answer tokens', async () => { /* usage.completion_tokens_details.reasoning_tokens = 32 */ })

it('sends only the fields the profile supplies — no temperature for a reasoning profile', async () => { /* assert the raw body keys */ })

it('never throws, and a timeout reports ok=false', async () => {
  const r = await probeProfile({ profile: profiles['translate'], model: 'gpt-6-luna', effort: 'none',
    budget: 2000, apiKey: 'k', timeoutMs: 5,
    fetchImpl: (async () => { await new Promise((res) => setTimeout(res, 50)); return reply({}) }) as any })
  expect(r.ok).toBe(false)
})

it('a profile supplies its own body verbatim', async () => {
  // profiles['why'].body('gpt-6-luna', 'none') must contain prompt/passages built by the
  // same code the route uses; this test pins that the profile is not a hand-written stub.
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest scripts/__tests__/probe-models.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement the profiles and the runner**

`probe-profiles.ts` builds each body from the same inputs the route would use — one representative fixture per profile (e.g. 6 documents with long snippets for `answer`, 25 passages for `why`), so the probe exercises the real shape including the JSON instructions in the prompt. The CLI:

```bash
npm run probe:models -- --task answer --models gpt-6.1-sol --effort medium
npm run probe:models                       # the default matrix below
```

Default matrix — the intended combinations, not every pairwise combination:

| Task | Models | Efforts |
|---|---|---|
| `answer` | `gpt-6.1-sol` | `medium` |
| `alignment.schema`, `alignment.json_object` | `gpt-6.1-terra` | `medium` |
| `why`, `relates`, `translate` | `gpt-6-luna` | `none` |
| `prefilter` | `gpt-6-luna` | `none` |

One line per case, with both verdicts distinguishable:

```
✓ gpt-6.1-sol  answer  medium  1420ms in=3120 out=610 reasoning=380 usable
✓ gpt-6.1-terra alignment.schema medium  980ms in=2400 out=340 reasoning=120 usable
✗ gpt-6-luna   translate none   410ms 400 Unsupported value: 'none' for gpt-6-…   not-usable
```

Bounded: a per-case `--timeout-ms` (default 120 000, ceiling 300 000 — the ALB idle timeout). **The CLI exits non-zero when any case in the requested matrix fails**, so this can be run in CI later. The printed header records endpoint, effort, budget, and the profile fixture version.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest scripts/__tests__/probe-models.test.ts`
Expected: PASS

- [ ] **Step 5: Run the default matrix against the real API and record it**

```bash
OPENAI_API_KEY=<the QA key> npm run probe:models | tee /tmp/probe-$(date +%F).txt
```

Paste the table into the commit message. One timing sample is an observation, not a latency baseline — say so in the commit body. This is the evidence that decides whether the migration goes ahead in this shape.

- [ ] **Step 6: Commit**

```bash
git add scripts/probe-models.ts scripts/probe-profiles.ts scripts/__tests__/probe-models.test.ts package.json
git commit -m "feat(scripts): probe the candidate models with our real request profiles"
```

---

### Task 2: The registry, with characterization tests first

**Files:**
- Create: `src/config/models.ts`
- Create: `src/lib/request-profile.ts`
- Create: `src/__tests__/models-registry.test.ts`
- Create: `src/__tests__/route-requests-unchanged.test.ts`
- Modify: `src/lib/llm/chat-completions.ts`, `src/lib/route-model.ts`, `src/lib/alignment-config.ts`, `src/lib/answer-synthesis.ts`
- Modify: `src/app/api/{answer,batch-why,batch-relates,alignment,translate}/route.ts`

**Interfaces:**
- Produces:

```ts
// src/config/models.ts
export type Effort = 'none' | 'low' | 'medium' | 'high'

export type ModelId =            // incumbents AND candidates are known models
  | 'gpt-4o-mini' | 'gpt-5-mini' | 'gpt-5.4' | 'gpt-5.4-nano'   // incumbents, still assigned below
  | 'gpt-6-astra' | 'gpt-6.1-sol' | 'gpt-6.1-terra' | 'gpt-6-luna'

export const MODELS: Record<ModelId, ModelSpec>   // capability + price; price unused this stage

/** Each task's CURRENT CODE DEFAULT — not the value production runs.
 *  Production overrides these through OPENAI_MODEL*, and that precedence is
 *  untouched in this stage (invariant 8). Using the deployed values here would
 *  change what a locally-run or env-less deployment sends, which is exactly what
 *  this stage promises not to do. */
export const ASSIGNMENT: Record<TaskId, ModelId>
// answer → 'gpt-5.4'        (answer-synthesis.ts:3)
// prefilter → 'gpt-5.4-nano' (answer/route.ts:21)
// why → 'gpt-4o-mini'        (batch-why/route.ts)
// relates → 'gpt-4o-mini'    (batch-relates/route.ts)
// alignment → 'gpt-5-mini'   (alignment-config.ts)
// translate → 'gpt-5-mini'   (translate/route.ts)

// src/lib/request-profile.ts
export function requestProfile(args: {
  task: TaskId
  model: ModelId | string        // string allowed: the eval-only callers send unregistered ids
  attempt: 'primary' | 'repair'
  input: { passages?: number; documents?: number; approxTokens?: number }
}): { maxCompletionTokens?: number; maxTokens?: number; temperature?: number; reasoningEffort?: Effort | undefined }
```

`ASSIGNMENT` and `MODELS` are deliberately separate: a model being *known* is not the same as a task being *assigned* to it, and conflating the two is what made the previous version of this plan contradictory.

`requestProfile` reproduces the formulas that exist today, moved rather than invented:

| Task | Budget today | Temperature today |
|---|---|---|
| answer | `max(2000, OPENAI_MAX_TOKENS)` for the GPT-5 class, else `OPENAI_MAX_TOKENS` | 0.3, env-overridable |
| prefilter | 500 | 0.1 |
| why | `min(200 + 80 × passages, 3000)` | 0.3 |
| relates | `max(1000, 120 × documents)` | configured |
| alignment | primary 4000, repair 5000 (GPT-5 class) | configured, omitted at effort ≠ none |
| translate | 2000 | 0.2 |

`reasoningEffort` returns `undefined` in this stage. Nothing adds the field.

- [ ] **Step 1: Write the characterization tests BEFORE touching any route**

These are the acceptance test for the whole task. They compare **raw body strings** and record **every** outbound call in order.

```ts
// src/__tests__/route-requests-unchanged.test.ts
/** @jest-environment node */
// post() and rawBodies() copied from src/__tests__/translate-route.test.ts, but
// capturing init.body as the RAW STRING rather than JSON.parse-ing it.
it('translate sends byte-identical bodies', async () => {
  await post({ text: 'Hola mundo' })
  expect(rawBodies()).toEqual([FIXTURE_TRANSLATE_RAW])
})
```

Fixtures required, one per branch that can change a request:

- **answer** — ≥ 8 documents with long snippets (to cross the 15×800 / 6×350 boundary), `prompt_version` v1 and v2, an explicit `max_passages` override.
- **answer prefilter** — enabled and disabled, success and provider failure. `/api/answer` shuffles passages with `Math.random()` at `answer/route.ts:170`: **stub the randomness** (`jest.spyOn(Math, 'random')`) and the provider replies, then assert the ordered call list.
- **batch-why** — passage counts below and above the `(3000 − 200) / 80 = 35`-passage cap.
- **batch-relates** — document counts below and above the `1000 / 120 = 9`-document floor boundary.
- **alignment** — one fixture per attempt: schema succeeds; schema fails then tools succeeds; schema and tools fail then json_object. Assert every attempt's body and budget.
- **translate** — the plainbody, plus the 400/502 paths.

- [ ] **Step 2: Run them and confirm they pass on today's code**

Run: `npx jest src/__tests__/route-requests-unchanged.test.ts`
Expected: PASS. These lock current behaviour before anything moves. State in the report that they compare raw strings and every call in order.

- [ ] **Step 3: Write the registry and its test**

```ts
it('every assigned task names a known model')          // assignment ⊆ models
it('registers every incumbent code default as a known model')  // gpt-4o-mini, gpt-5-mini, gpt-5.4, gpt-5.4-nano
it('assigns each task its current code default')               // the table in the Interfaces block
it('declares the candidates as known but unassigned')          // the four gpt-6 ids appear in MODELS, not in ASSIGNMENT
it('records capability without asserting it is used')  // supportsEffortNone only; no price assertions this stage
```

Run: `npx jest src/__tests__/models-registry.test.ts` — FAIL, implement, PASS.

- [ ] **Step 4: Move each budget formula into `requestProfile`, leaving behaviour alone**

Replace the `isGpt5` string matches in the four `src/lib` files and five routes with `requestProfile(...)` calls that take the route's task, attempt and input size. Delete every `/^gpt-5/i`, `includes('gpt-5')`, `includes('gpt-4o')` and `=== 'gpt-5-mini'` test. Keep the eval-only branch for unregistered ids **exactly as it behaves today, per caller** — the judge's `max_tokens` + `temperature: 0` arm and each route's own configured temperature are different profiles and must not be merged.

- [ ] **Step 5: Preserve alignment's timeout calculation**

Keep the prompt-size scaling and clamps in `alignment-config.ts`; the 40 000 / 25 000 values are bases, not final deadlines. Add a test that asserts the **resulting** deadlines for a small prompt (the base) and a large prompt (the clamped ceiling of 60 000 / 50 000), so a change from "bases preserved" to "bases treated as finals" fails.

- [ ] **Step 6: Run the characterization tests**

Run: `npx jest src/__tests__/route-requests-unchanged.test.ts`
Expected: **PASS with every fixture untouched.** A failure means the rewiring changed an outgoing request — fix the code, never the fixture. Report any fixture you changed and why.

- [ ] **Step 7: Full gates, then commit**

Run: `npx jest && npm run lint && npm run format:check`
Expected: PASS.

```bash
git add src/config/models.ts src/lib src/app/api src/__tests__/models-registry.test.ts src/__tests__/route-requests-unchanged.test.ts
git commit -m "refactor(routes): request parameters from one profile builder, raw bodies unchanged"
```

---

## Deferred — deliberately not in this plan

Each is small and can be its own chore:

- **The model swap** — design sequence steps 3–6, each gated on measured evidence.
- **Pricing** — `costs.ts`, `energy.ts`, `topicsAdmin.ts`, `utils.tsx` reading the registry and throwing on unknown models. Do this *before* any model changes, or the cost figures go stale.
- **`MODEL_<TASK>` levers**, and making the legacy `OPENAI_MODEL*` keys inert. Currently deferred because making them inert is itself a configuration change, and the two-tier precedence needs its own decision.
- **Removing `temperature`** and **adding explicit `reasoning_effort`** — both are migration-time behaviour changes, not refactors.
- **Deleting alignment's `tools` rung** — a migration decision, and it should be made with probe evidence in hand rather than assumed.
- **The Python mirror**, cross-language fixture, and the legacy embedder deletion.
- **The judge** (`evaluation/answer/judge-client.ts`) is not wired in this stage; its own `/^gpt-5/i` mirror stays until a task actually calls it.
