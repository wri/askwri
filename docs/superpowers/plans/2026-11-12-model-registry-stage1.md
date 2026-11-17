# Model Registry Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find out whether the new OpenAI models work for us and at what cost, and put every model id and parameter behind one file — changing no model.

**Architecture:** Two tasks that can ship independently. A probe script that sends each real request shape to each candidate model and reports what happened. And a registry (`src/config/models.ts`) plus `paramsFor()`, replacing the `/^gpt-5/` string matches, with recorded-request tests proving every route still sends exactly what it sends today.

**Tech Stack:** TypeScript, Jest (`@jest-environment node`), `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-12-model-config-and-gpt6-design.md` — steps 1 and 2 of §10.

## Global Constraints

- **No model changes.** Every task maps to the model it runs in production today.
- **No outgoing request changes.** Task 2 records each route's request body before the rewiring and asserts it identical after — the same bytes, not "equivalent".
- `temperature` is never sent for a registry model; `max_completion_tokens` always is. The eval-only path (GLM judge, cross-provider answer candidates) keeps `max_tokens` + `temperature: 0`.
- Env levers are named `MODEL_<TASK>` and must name a registry id, or the process fails at boot.
- No new npm dependencies.
- `npx jest`, `npm run lint`, `npm run format:check` must pass before each commit.
- Branch only. Never push to `main` or `production`.

## Review Focus

- **The probe reporting ✓ when the real request shape fails.** A trivial completion proves access, not that a structured-output request at `medium` effort is accepted. Owned by Task 1.
- **A rewiring that silently changes what a route sends.** Owned by Task 2's recorded-request tests.
- **An eval-only caller losing its parameters.** The GLM judge and cross-provider candidates depend on `max_tokens` + `temperature: 0`. Owned by Task 2.
- **A stale env value at boot.** Owned by Task 2.

---

### Task 1: The probe

**Files:**
- Create: `scripts/probe-models.ts`
- Create: `scripts/__tests__/probe-models.test.ts`
- Modify: `package.json` (add `"probe:models": "npx tsx scripts/probe-models.ts"`)

**Interfaces:**
- Produces:
  - `export type ProbeShape = 'json_schema' | 'json_object' | 'plain'`
  - `export interface ProbeResult { ok: boolean; status?: number; error?: string; latencyMs: number; promptTokens?: number; completionTokens?: number; reasoningTokens?: number; parsed?: boolean }`
  - `export async function probeModel(args: { model: string; shape: ProbeShape; effort: 'none' | 'low' | 'medium'; apiKey: string; fetchImpl?: typeof fetch }): Promise<ProbeResult>`

The three shapes are the ones we actually send: `json_schema` uses the alignment schema, `json_object` uses the answer prompt, `plain` uses a translate body. Model ids are plain strings here — the probe runs before the registry exists, and it is the thing that tells us which ids are worth registering.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/__tests__/probe-models.test.ts
/** @jest-environment node */
import { probeModel } from '../probe-models'

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response

it('sends reasoning_effort, max_completion_tokens, and no temperature', async () => {
  let sent: any
  await probeModel({ model: 'gpt-6.1-sol', shape: 'json_object', effort: 'medium', apiKey: 'k',
    fetchImpl: (async (_u: any, init: any) => { sent = JSON.parse(init.body); return reply({ choices: [{ message: { content: '{}' } }], usage: {} }) }) as any })
  expect(sent.reasoning_effort).toBe('medium')
  expect(sent.max_completion_tokens).toBeGreaterThan(0)
  expect(sent.temperature).toBeUndefined()
})

it('reports reasoning tokens separately from answer tokens', async () => {
  const r = await probeModel({ model: 'gpt-6-luna', shape: 'plain', effort: 'low', apiKey: 'k',
    fetchImpl: (async () => reply({ choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 210, completion_tokens: 76, completion_tokens_details: { reasoning_tokens: 32 } } })) as any })
  expect(r).toMatchObject({ ok: true, promptTokens: 210, completionTokens: 76, reasoningTokens: 32 })
})

it('marks a rejected request as not ok and keeps the message', async () => {
  const r = await probeModel({ model: 'gpt-6-astra', shape: 'json_schema', effort: 'none', apiKey: 'k',
    fetchImpl: (async () => reply({ error: { message: 'Unsupported value: none' } }, 400)) as any })
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/Unsupported value/)
})

it('reports parsed false when a json_schema reply is not JSON', async () => {
  const r = await probeModel({ model: 'gpt-6-luna', shape: 'json_schema', effort: 'low', apiKey: 'k',
    fetchImpl: (async () => reply({ choices: [{ message: { content: 'Sure! Here is the assessment:' } }], usage: {} })) as any })
  expect(r.ok).toBe(true)
  expect(r.parsed).toBe(false)
})

it('never throws on a network failure', async () => {
  const r = await probeModel({ model: 'gpt-6-luna', shape: 'plain', effort: 'none', apiKey: 'k',
    fetchImpl: (async () => { throw new Error('ECONNRESET') }) as any })
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/ECONNRESET/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest scripts/__tests__/probe-models.test.ts`
Expected: FAIL — `Cannot find module '../probe-models'`

- [ ] **Step 3: Implement `scripts/probe-models.ts`**

CLI flags `--models a,b`, `--shapes`, `--effort`; defaults to the four GPT-6 ids and all three shapes. One line per model × shape:

```
✓ gpt-6.1-sol  json_object  820ms in=210 out=76 reasoning=32 parsed
✗ gpt-6-astra  json_schema   430ms 400 Unsupported value: 'none'
```

Never throws: a failure becomes an `✗` line with the reason.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest scripts/__tests__/probe-models.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run it against the real API and record the output**

```bash
OPENAI_API_KEY=<the QA key> npm run probe:models -- --effort low
```

Paste the full table into the commit message. This is the evidence the rest of the design depends on: which ids are reachable, which shapes they accept at which effort, their latency, and their reasoning-token share.

- [ ] **Step 6: Commit**

```bash
git add scripts/probe-models.ts scripts/__tests__/probe-models.test.ts package.json
git commit -m "feat(scripts): probe each model with the request shapes we actually send"
```

---

### Task 2: The registry, and every route reading from it

**Files:**
- Create: `src/config/models.ts`
- Create: `src/__tests__/models-registry.test.ts`
- Create: `src/__tests__/route-requests-unchanged.test.ts`
- Modify: `src/lib/llm/chat-completions.ts`, `src/lib/route-model.ts`, `src/lib/alignment-config.ts`, `src/lib/answer-synthesis.ts`
- Modify: `src/app/api/{answer,batch-why,batch-relates,alignment,translate}/route.ts`

**Interfaces:**
- Produces:
  - `export type ModelId = 'gpt-6-astra' | 'gpt-6.1-sol' | 'gpt-6.1-terra' | 'gpt-6-luna'`
  - `export type TaskId = 'answer' | 'why' | 'relates' | 'alignment' | 'translate' | 'prefilter' | 'judge'`
  - `export const MODELS: Record<ModelId, ModelSpec>`; `export const TASKS: Record<TaskId, TaskSpec>`
  - `export function modelFor(task: TaskId): { model: ModelId; effort: Effort }`
  - `export function paramsFor(model: string): RequestParams` — in `chat-completions.ts`; `RequestParams = { maxCompletionTokens?: number; maxTokens?: number; temperature?: number; reasoningEffort?: Effort }`. Registry id → `{ maxCompletionTokens, reasoningEffort }`; anything else → `{ maxTokens, temperature: 0 }`, commented as the eval-only arm.
  - `ModelSpec.price` and `ModelSpec.supportsEffortNone` are declared now even though nothing reads them yet — they are the reason the file exists, and the migration task will.

- [ ] **Step 1: Record what the routes send today**

Add `src/__tests__/route-requests-unchanged.test.ts` capturing each route's outgoing body for one fixed input, with the captured bodies pasted in as fixtures. Copy the `post()` / `sentBody()` pattern from `src/__tests__/translate-route.test.ts`.

```ts
it('translate sends the same body as before the rewiring', async () => {
  await post({ text: 'Hola mundo' })
  expect(sentBody()).toEqual(FIXTURE_TRANSLATE)
})
// …batch-why, batch-relates, alignment, answer
```

- [ ] **Step 2: Run to verify the fixtures pass on today's code**

Run: `npx jest src/__tests__/route-requests-unchanged.test.ts`
Expected: PASS. These lock current behaviour before anything moves.

- [ ] **Step 3: Write the registry and its test**

```ts
it('every task names a registered model')
it('refuses an effort the model cannot run')       // 6.1-sol + none throws; luna + none does not
it('carries the published prices')                 // the four rows from the design doc
it('honours a MODEL_<TASK> lever naming a registry id')
it('throws on a lever naming nothing the registry has')   // e.g. a stale gpt-5.4-mini
```

Task table maps every task to **today's model**, expressed in the new type with a `// MIGRATION: <current model>` comment on each line.

Run: `npx jest src/__tests__/models-registry.test.ts` — expected FAIL, then implement, then PASS.

- [ ] **Step 4: Replace `isGpt5` with `paramsFor`**

Delete every `/^gpt-5/i`, `includes('gpt-5')`, `includes('gpt-4o')` and `=== 'gpt-5-mini'` branch in the four `src/lib` files and the five routes. Routes resolve their model and parameters through the registry.

- [ ] **Step 5: Run the recorded-request tests**

Run: `npx jest src/__tests__/route-requests-unchanged.test.ts`
Expected: **PASS with the fixtures untouched.** If one fails, the rewiring changed the outgoing request — fix the code, never the fixture. Report any fixture you changed and why.

- [ ] **Step 6: Full gates, then commit**

Run: `npx jest && npm run lint && npm run format:check && npx next build --webpack`
Expected: PASS. Existing route tests that asserted `isGpt5`-shaped params may need their assertions re-pointed at `paramsFor`; report which.

```bash
git add src/config/models.ts src/lib src/app/api src/__tests__/models-registry.test.ts src/__tests__/route-requests-unchanged.test.ts
git commit -m "refactor(routes): read model parameters from one registry, requests unchanged"
```

---

## Deferred — deliberately not in this plan

Each of these is small and can be its own chore whenever it earns its keep:

- **Cost and energy tables** (`costs.ts`, `energy.ts`, `topicsAdmin.ts`, `utils.tsx`) reading the registry instead of their own name tables, and throwing on an unknown model instead of billing the gpt-4o-mini rate. Worth doing before the model swap, because swapping models with stale price tables makes the cost figures wrong.
- **The Python mirror** and the cross-language fixture. Separate deployment, separate change.
- **Removing the `OPENAI_MODEL*` / `OPENAI_MAX_TOKENS` / `OPENAI_TEMPERATURE` levers** and the Terraform `worker_llm_model` pin. They become inert once Task 2 lands; deleting them is tidying.
- **Deleting the legacy `text-embedding-3-small` embedder** and parameterising the `classify.py` SQL literal. Zero rows use it; no urgency.
- **The model swap itself** — steps 3–6 of the design's sequence, each gated on measured evidence.
