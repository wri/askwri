# Route Model Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person run the same real inputs through two OpenAI models on the four routes that have no evaluation today, and read the outputs side by side before changing the model those routes use.

**Architecture:** Two PRs. PR 1 adds a token-gated per-request model override plus a machine-readable `provenance` block to `batch-why`, `batch-relates`, `alignment`, `translate` — without it a model swap cannot be measured and a route that returned canned text looks identical to one that answered. PR 2 adds `evaluation/route-sweep/`: freeze one cite retrieval per case, project it into each route's real payload using the UI's own builders, call every route at both models, and render a side-by-side a human reads once.

**Tech Stack:** Next.js 16 route handlers (TypeScript), Jest + jsdom (`@jest-environment node` for these suites), `tsx` for evaluation scripts, Terraform for the QA env var.

**Spec:** `docs/superpowers/specs/2026-11-12-route-model-sweep-design.md`

## Global Constraints

- No new npm dependencies. Use `fetch`, `node:crypto`, `undici` where already used.
- Route response changes are **additive only**: every existing field keeps its name, shape and meaning. `provenance` is new.
- `EVAL_MODEL_OVERRIDE_TOKEN` is set in `terraform/environments/qa.tfvars` and **absent from `terraform/environments/production.tfvars`**. Production must refuse overrides by construction.
- An override request without a valid token returns **400**, never a silent fallback to the default model.
- Model-derived parameters (token caps, temperature, timeouts) must be computed from the **resolved** model, never from a module-scope const.
- Scripts run from the repo root; `tsx` resolves the `@/` alias from the cwd's tsconfig.
- Evaluation scripts never write outside `evaluation/results/` and `evaluation/baselines/`.
- Branch `qa` only. Never push or open a PR against `main` or `production`.
- `npm test`, `npm run lint`, `npm run format:check` must pass before each PR.

## Review Focus

- **A model call that failed and was replaced by canned text.** The route answers `200 ok:true` with plausible strings. Expected: that row is labelled `produced: false` with a reason and is visibly not evidence. Owned by Tasks 2–5 (per-route provenance) and Task 9 (the check that reads it).
- **A frozen retrieval that returned zero documents.** `batch-relates` answers `{ok:true, results: []}` without calling a model. Expected: the case is reported as unusable, not as a clean agreement between two models. Owned by Task 7 (freeze records the doc count) and Task 9.
- **An override sent to an environment with no token configured** (production, or QA before Task 6). Expected: 400, never the incumbent model's output relabelled as the candidate. Owned by Task 1 and re-asserted per route in Tasks 2–5.
- **A candidate model whose name is not `gpt-5*`.** Expected: that request gets the non-GPT-5 parameters, because the route computed them from the resolved model. Owned by Tasks 2–5.
- **The sweep run against a QA image that predates PR 1.** Expected: the artifact header names the deployed image digest, and says `unknown` loudly when it cannot. Owned by Task 9.

---

## PR 1 — the override knob and provenance

### Task 1: Resolve a per-request model, and the token gate

**Files:**
- Create: `src/lib/route-model.ts`
- Create: `src/__tests__/route-model.test.ts`
- Modify: `.env.example` (documented, commented out)

**Interfaces:**
- Produces:
  - `export type RouteProvenance = { model: string; produced: boolean; fallback_reason?: string; sanitized?: boolean }`
  - `export function resolveRouteModel(req: Request, body: unknown, fallback: string): { ok: true; model: string; isGpt5: boolean } | { ok: false; error: string }`
  - Reads `process.env.EVAL_MODEL_OVERRIDE_TOKEN` **at call time** (not at import), and the `x-eval-token` request header.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/route-model.test.ts
/** @jest-environment node */
import { resolveRouteModel } from '@/lib/route-model'

const req = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/x', { method: 'POST', headers })

afterEach(() => {
  delete process.env.EVAL_MODEL_OVERRIDE_TOKEN
})

it('uses the fallback when no model is requested', () => {
  expect(resolveRouteModel(req(), {}, 'gpt-5.4-nano')).toEqual({
    ok: true,
    model: 'gpt-5.4-nano',
    isGpt5: true,
  })
})

it('uses the fallback for a blank or non-string model', () => {
  expect(resolveRouteModel(req(), { model: '   ' }, 'gpt-5.4-nano').ok).toBe(true)
  expect(resolveRouteModel(req(), { model: 42 }, 'gpt-5.4-nano')).toEqual(
    expect.objectContaining({ ok: true, model: 'gpt-5.4-nano' }),
  )
})

it('rejects an override when no token is configured', () => {
  expect(resolveRouteModel(req(), { model: 'gpt-5.6-luna' }, 'gpt-5.4-nano')).toEqual({
    ok: false,
    error: 'model override not enabled',
  })
})

it('rejects an override whose header does not match the token', () => {
  process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
  expect(
    resolveRouteModel(req({ 'x-eval-token': 'wrong' }), { model: 'gpt-5.6-luna' }, 'gpt-5.4-nano').ok,
  ).toBe(false)
  expect(
    resolveRouteModel(req(), { model: 'gpt-5.6-luna' }, 'gpt-5.4-nano').ok,
  ).toBe(false)
})

it('honours an override with the matching token', () => {
  process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
  expect(
    resolveRouteModel(req({ 'x-eval-token': 'secret' }), { model: 'gpt-5.6-luna' }, 'gpt-5.4-nano'),
  ).toEqual({ ok: true, model: 'gpt-5.6-luna', isGpt5: true })
})

it('reports isGpt5 false for a non-gpt-5 name', () => {
  process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
  expect(
    resolveRouteModel(req({ 'x-eval-token': 'secret' }), { model: 'o4-mini' }, 'gpt-5.4-nano'),
  ).toEqual({ ok: true, model: 'o4-mini', isGpt5: false })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/route-model.test.ts -t 'uses the fallback'`
Expected: FAIL — `Cannot find module '@/lib/route-model'`

- [ ] **Step 3: Implement `src/lib/route-model.ts`**

Header comment: one line stating that the override exists for `evaluation/route-sweep/` and is refused when no token is configured, so production cannot be swept by accident. Trim the requested model; treat a non-string or blank `model` as absent. Compare header to env token exactly. `isGpt5 = /^gpt-5/i.test(model)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/route-model.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Document the variable in `.env.example`**

Add near the existing `OPENAI_MODEL*` block, commented out, with a one-line note that it enables `?model` overrides on the four analysis routes and must never be set in production.

- [ ] **Step 6: Commit**

```bash
git add src/lib/route-model.ts src/__tests__/route-model.test.ts .env.example
git commit -m "feat(routes): token-gated per-request model override"
```

---

### Task 2: `translate` — resolve the model per request, add provenance

**Files:**
- Modify: `src/app/api/translate/route.ts`
- Create: `src/__tests__/translate-route.test.ts`

**Interfaces:**
- Consumes: `resolveRouteModel` from Task 1.
- Produces: every JSON response carries `provenance: RouteProvenance`. `ok: true` keeps its existing `translation` field; the existing top-level `model` field stays for compatibility.

- [ ] **Step 1: Write the failing test**

`__tests__` pattern as in `src/__tests__/answer-route.test.ts`: mock `global.fetch` to return a chat completion, `jest.resetModules()` in `beforeEach` so `process.env` changes are picked up, and a `post(body, headers)` helper returning `{ status, json }`.

```ts
it('defaults to the env model and reports it', async () => {
  process.env.OPENAI_MODEL = 'gpt-5.4-mini'
  const { status, json } = await post({ text: 'Hola mundo' })
  expect(status).toBe(200)
  expect(json.provenance).toEqual({ model: 'gpt-5.4-mini', produced: true })
})

it('rejects an override with no token', async () => {
  const { status, json } = await post({ text: 'Hola', model: 'gpt-5.6-luna' })
  expect(status).toBe(400)
  expect(json.provenance.produced).toBe(false)
})

it('runs the requested model when the token matches', async () => {
  process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
  const { json } = await post({ text: 'Hola', model: 'gpt-5.6-luna' }, { 'x-eval-token': 'secret' })
  expect(json.provenance.model).toBe('gpt-5.6-luna')
  expect(sentBody().model).toBe('gpt-5.6-luna')
})

it('computes MAX_TOKENS from the resolved model, not the module const', async () => {
  // default model gpt-5-mini → 2000; override to a non-gpt-5 name → 1200
  process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
  await post({ text: 'Hola', model: 'gpt-4o-mini' }, { 'x-eval-token': 'secret' })
  expect(sentBody().max_tokens).toBe(1200)
})

it('marks the unavailable and empty-translation paths as not produced', async () => {
  // fetch mocked to 500 → status 503, provenance.produced false, fallback_reason present
  // fetch mocked to an empty completion → status 422, provenance.produced false
})

it('marks the API-key-missing path as not produced', async () => {
  delete process.env.OPENAI_API_KEY
  const { status, json } = await post({ text: 'Hola' })
  expect(status).toBe(503)
  expect(json.provenance.produced).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/translate-route.test.ts`
Expected: FAIL — `provenance` undefined

- [ ] **Step 3: Wire the resolver into `src/app/api/translate/route.ts`**

Delete the `IS_GPT5` / `MAX_TOKENS` module consts. In `POST`, after parsing the body, resolve the model and return 400 on rejection with `{ ok: false, error, provenance: { model: fallback, produced: false, fallback_reason: 'model_override_rejected' } }`. Compute `MAX_TOKENS` from `resolved.isGpt5` inline. Add `provenance` to all six return sites; keep the existing top-level `model`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/translate-route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/translate/route.ts src/__tests__/translate-route.test.ts
git commit -m "feat(translate): per-request model override and provenance"
```

---

### Task 3: `batch-relates` — resolve the model, provenance on every fallback

**Files:**
- Modify: `src/app/api/batch-relates/route.ts`
- Create: `src/__tests__/batch-relates-route.test.ts`

**Interfaces:**
- Consumes: `resolveRouteModel` from Task 1.
- Produces: `provenance` on all six return sites (`:73` empty docs, `:83` no key, `:140` upstream error, `:183` success, `:191` parse error, `:193` catch). `produced: false` for every path that did not yield model text, with `fallback_reason` naming the cause (`no_docs`, `no_api_key`, `upstream_<status>`, `parse_error`, `error`), and `sanitized` when the English fallback replaced mirrored output.

- [ ] **Step 1: Write the failing test**

Same helper pattern as Task 2, with `docs` fixtures of 2 items.

```ts
it('reports produced true on a parsed success', ...)            // status 200, provenance.produced true, model echoed
it('reports produced false and reason no_docs for an empty doc list', ...)   // {ok:true, results: []} + produced false
it('reports produced false and reason upstream_500 on provider error', ...)  // canned text present, provenance says so
it('reports produced false and reason parse_error on unparseable content', ...)
it('reports sanitized true when the English fallback replaces mirrored output', ...)
  // completion content is Chinese prose → results replaced by the canned string,
  // provenance.produced true (the model did answer) and provenance.sanitized true
it('rejects an override with no token', ...)                   // 400
it('computes output tokens from the resolved model', ...)       // non-gpt-5 override → 1200-class max_tokens in sentBody()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/batch-relates-route.test.ts`
Expected: FAIL — `provenance` undefined

- [ ] **Step 3: Wire `src/app/api/batch-relates/route.ts`**

Replace the module `MODEL`/`IS_GPT5` with a per-request resolve at the top of `POST`, before the `docs` guard. Thread `resolved.model` into the request body and `resolved.isGpt5` into the token/param branches at `:101` and `:111`. Add `provenance` to all six returns. In the success branch, track whether any item was replaced by the `isEnglishText` guard and set `sanitized: true` on the provenance when it was.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/batch-relates-route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/batch-relates/route.ts src/__tests__/batch-relates-route.test.ts
git commit -m "feat(batch-relates): per-request model override and provenance"
```

---

### Task 4: `batch-why` — resolve the model, provenance on the silent-English path

**Files:**
- Modify: `src/app/api/batch-why/route.ts`
- Create: `src/__tests__/batch-why-route.test.ts`

**Interfaces:**
- Consumes: `resolveRouteModel` from Task 1.
- Produces: `provenance` on all four return sites (`:255` success, `:267` parse fallback, `:281` catch, plus the 400). The `isEnglishText` substitution at `:228-231` sets `sanitized: true` — this path currently sets no flag at all.
- Note: `calculateOptimalTokens(passages, model)` and `getModelParams(model, tokenCount)` already take the model as a parameter; they need no signature change, only the resolved value.

- [ ] **Step 1: Write the failing test**

```ts
it('reports produced true and the resolved model on success', ...)
it('reports produced false and reason parse_error on unparseable content', ...)  // existing fallback:true keeps its field
it('reports sanitized true when a mirrored explanation is replaced', ...)
  // model returns one Chinese `why` → that item is the canned sentence,
  // provenance.produced true, provenance.sanitized true
it('returns 400 for an override with no token', ...)
it('sizes tokens from the resolved model', ...)   // non-gpt-5 override → 2500 cap, not 3000
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/batch-why-route.test.ts`
Expected: FAIL — `provenance` undefined

- [ ] **Step 3: Wire `src/app/api/batch-why/route.ts`**

Replace the module `OPENAI_MODEL` with a per-request resolve. Pass `resolved.model` to `calculateOptimalTokens` and `getModelParams`, and use it in the outgoing body. Add `provenance` to all returns; set `sanitized: true` when the English guard replaced at least one explanation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/batch-why-route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/batch-why/route.ts src/__tests__/batch-why-route.test.ts
git commit -m "feat(batch-why): per-request model override and provenance"
```

---

### Task 5: `alignment` — lift the derived config out of module scope

**Files:**
- Modify: `src/app/api/alignment/route.ts`
- Create: `src/__tests__/alignment-route.test.ts`

**Interfaces:**
- Consumes: `resolveRouteModel` from Task 1.
- Produces:
  - `function resolveAlignmentConfig(model: string): { model: string; isGpt5: boolean; mainMs: number; repairMs: number; mainMax: number; repairMax: number; temperature: number }` — exported for its own test.
  - `provenance` on every return: the two `ok:false` rejections, the success assessment, the deterministic fallback (`:593`), and the catch (`:619`). The existing `debug.fallback` / `debug.reason` fields stay as they are.
  - `provenance.sanitized: true` when `sanitizeAssessment` (`:216`) replaced the insights or coerced the alignment value.

- [ ] **Step 1: Write the failing test**

```ts
it('derives GPT-5 timeouts and caps for a gpt-5 model', ...)      // cfg.mainMs 40000, mainMax 4000
it('derives non-GPT-5 timeouts and caps for other models', ...)   // cfg.mainMs 20000, mainMax <= 1500
it('reports produced true on a parseable assessment', ...)
it('reports produced false with reason on every fallback path', ...)
  // upstream 500, empty content, and a thrown error each yield provenance.produced false
it('reports sanitized true when sanitizeAssessment substitutes insights', ...)
  // model returns non-English insights → canned insight, provenance.sanitized true
it('returns 400 for an override with no token', ...)
it('sends the resolved model, not the module const', ...)         // sentBody().model
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/alignment-route.test.ts`
Expected: FAIL — `resolveAlignmentConfig` is not exported

- [ ] **Step 3: Extract `resolveAlignmentConfig` and wire the route**

Move `IS_GPT5`, `DEFAULT_*_MS`, `BASE_*_MS`, `ENV_MAX`, `MAIN_MAX`, `REPAIR_MAX`, `TEMPERATURE` out of module scope into the function, reading env inside it. Keep `CFG_*` imports from `@/config/alignment` as the fallbacks. Call it once per request from the resolved model and thread the values where the consts were used. Add `provenance` to every return.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/alignment-route.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. Any suite that imported these route modules and relied on module-level env reads must be updated in the same commit — report which ones you touched.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/alignment/route.ts src/__tests__/alignment-route.test.ts
git commit -m "feat(alignment): per-request model override and provenance"
```

---

### Task 6: Enable the override in QA

**Files:**
- Modify: `terraform/environments/qa.tfvars`
- Modify: `docs/model-inventory-and-migration.md` (one line: the routes are now sweepable)

**Interfaces:**
- Produces: a QA deployment where `POST /api/translate` with `model` and no `x-eval-token` returns 400, and with the token returns 200.

- [ ] **Step 1: Add the variable**

In `qa.tfvars` `app_environment_variables`, add `"EVAL_MODEL_OVERRIDE_TOKEN"` with a comment stating what it gates, that production must not set it, and that it bounds accidents only — anyone who can read the repo or the task definition already knows the value and holds the OpenAI key anyway. **The value goes in git, so treat it as public:** generate it once, and rotate it if a private value is ever wanted.

- [ ] **Step 2: Confirm production has no reference to it**

Run: `grep -rn EVAL_MODEL_OVERRIDE_TOKEN terraform/`
Expected: one hit, in `qa.tfvars` only.

- [ ] **Step 3: Push and let QA deploy**

Follow `docs/runbooks/qa-push-deploy.md`. Do not merge to `main`.

- [ ] **Step 4: Verify the gate on the deployed service**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://qa.askwri-app.org/api/translate \
  -H 'content-type: application/json' -d '{"text":"Hola mundo","model":"gpt-5.6-luna"}'
# Expected: 400

curl -s -X POST https://qa.askwri-app.org/api/translate \
  -H 'content-type: application/json' -H "x-eval-token: $EVAL_MODEL_OVERRIDE_TOKEN" \
  -d '{"text":"Hola mundo","model":"gpt-5.6-luna"}' | head -c 400
# Expected: 200 body, provenance.model == "gpt-5.6-luna"
```

- [ ] **Step 5: Commit**

```bash
git add terraform/environments/qa.tfvars docs/model-inventory-and-migration.md
git commit -m "chore(qa): enable the route model override for the sweep"
```

---

## PR 2 — the sweep tool

### Task 7: Freeze one retrieval per case

**Files:**
- Create: `evaluation/route-sweep/types.ts`
- Create: `evaluation/route-sweep/freeze.ts`
- Create: `evaluation/__tests__/route-sweep-freeze.test.ts`

**Interfaces:**
- Produces:

```ts
// evaluation/route-sweep/types.ts
export type RouteName = 'batch-why' | 'batch-relates' | 'alignment' | 'translate'
export type FrozenCase = { id: string; question: string; source_language?: string; docs: any[]; doc_count: number }
export type FrozenSet = {
  label: string; target: string; evalset: string; submodule_commit: string
  max_results: number; cases: FrozenCase[]
}
export type CallResult = {
  route: RouteName; case_id: string; model: string
  request: unknown; response: unknown
  provenance?: import('@/lib/route-model').RouteProvenance
  latency_ms: number; error?: string
}
export type SweepArtifact = {
  label: string; target: string; models: [string, string]
  code_version: string | null; max_results: number
  submodule_commit: string; calls: CallResult[]
}
// evaluation/route-sweep/freeze.ts
export function loadEvalset(path: string, opts: { limit?: number; ids?: string[] }):
  { id: string; question: string; source_language?: string }[]
export async function freezeCases(args: {
  cases: { id: string; question: string; source_language?: string }[]
  target: string
  maxResults: number
  fetchImpl?: typeof fetch
}): Promise<FrozenSet>
```

- [ ] **Step 1: Write the failing test**

```ts
it('posts {query, mode:cite, max_results} to /api/llamaindex on the target', ...)
it('records docs and doc_count per case', ...)
it('records max_results and the submodule commit in the set', ...)   // commit from git, mocked child_process
it('records doc_count 0 without throwing when a case returns no docs', ...)
it('loads the first N cases of a named evalset', ...)                // evalset_answer_02, --limit 2 → 2 cases
it('loads exactly the requested ids and errors on an unknown id', ...)
it('prefers expert_approved cases when the set has any', ...)        // and records that it did not when none do
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest evaluation/__tests__/route-sweep-freeze.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `freeze.ts` and `types.ts`**

`loadEvalset` reads `{ test_cases: [...] }` from the pinned submodule evalset and maps each to `{ id, question, source_language }`. Prefer `review_status === 'expert_approved'` only when at least one case has it; there are none at the current pin (`1dcbeab`), so the default is "first N in file order" and the artifact header must say the set has no reviewed tier.

Post `{ query, mode: 'cite', max_results: maxResults }` and store the parsed JSON's `docs` array. Read the submodule commit with `git -C evaluation/eval-review rev-parse HEAD` via `node:child_process`. Zero docs is recorded, not thrown — Task 9 decides what to do with it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest evaluation/__tests__/route-sweep-freeze.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add evaluation/route-sweep/types.ts evaluation/route-sweep/freeze.ts evaluation/__tests__/route-sweep-freeze.test.ts
git commit -m "feat(route-sweep): load an evalset and freeze one cite retrieval per case"
```

---

### Task 8: Project a frozen case into each route's real payload

**Files:**
- Create: `evaluation/route-sweep/payloads.ts`
- Create: `evaluation/__tests__/route-sweep-payloads.test.ts`

**Interfaces:**
- Consumes: `FrozenCase`; `buildAlignmentSummary`, `titleFrom`, `authorsFrom`, `yearFrom`, `normalizeCatalogRow`, `buildCatalogIndex` from `@/app/utils/utils`; `RouteName` from Task 7.
- Produces:
  - `export async function fetchCatalogIndex(target: string, fetchImpl?: typeof fetch): Promise<ReturnType<typeof buildCatalogIndex> | null>`
  - `export function buildPayloads(c: FrozenCase, index: ReturnType<typeof buildCatalogIndex> | null): Record<RouteName, unknown>`

- [ ] **Step 1: Write the failing test**

```ts
it('builds {query, mode, passages:[{docTitle, snippet}]} for batch-why', ...)
it('builds {query, docs:[{title, authors, year, snippet}]} for batch-relates', ...)
it('builds {query, resultsSummary} for alignment with the catalog index', ...)
it('builds {text} for translate from the first non-English snippet', ...)
it('uses the real question, not the UI placeholder "answer"', ...)   // pins the spec's known limit
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest evaluation/__tests__/route-sweep-payloads.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `payloads.ts`**

Fetch `${target}/api/catalog`, map `.items` through `normalizeCatalogRow`, then `buildCatalogIndex`. Mirror `src/app/results/page.tsx:355-380` for the relates payload and `:419` for alignment, and `SupportingCitations.tsx:159` for why — by calling the shared builders, not by copying their logic. For translate, pick the first snippet containing non-ASCII characters; fall back to the first snippet and record which case has no non-ASCII text.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest evaluation/__tests__/route-sweep-payloads.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add evaluation/route-sweep/payloads.ts evaluation/__tests__/route-sweep-payloads.test.ts
git commit -m "feat(route-sweep): project frozen cases into route payloads"
```

---

### Task 9: Sweep both models and check each call

**Files:**
- Create: `evaluation/route-sweep/checks.ts`
- Create: `evaluation/route-sweep/sweep.ts`
- Create: `evaluation/__tests__/route-sweep-checks.test.ts`

**Interfaces:**
- Consumes: `CallResult`, `RouteName`, `FrozenCase` (Task 7); `buildPayloads` (Task 8).
- Produces:
  - `export function checkCall(r: CallResult, expectedModel: string, inputCount: number): { ok: boolean; failures: string[] }`
  - `export async function runSweep(args: { cases: FrozenCase[]; routes: RouteName[]; models: [string, string]; catalogIndex: ReturnType<typeof import('@/app/utils/utils').buildCatalogIndex> | null; target: string; token: string; timeoutMs: number; concurrency: number; fetchImpl?: typeof fetch }): Promise<CallResult[]>`
  - `export async function resolveCodeVersion(service: string, cluster: string, region: string): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

```ts
it('fails a call whose provenance.produced is false', ...)
it('fails a call whose provenance.model does not equal the requested model', ...)
it('fails an array route whose output length does not match the input count', ...)
it('fails an empty-text translate response', ...)
it('fails a call whose case had zero documents', ...)      // inputCount 0 is a failure, never a pass
it('passes a well-formed success', ...)
it('times out a call that exceeds timeoutMs and records an error, not a throw', ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest evaluation/__tests__/route-sweep-checks.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `checks.ts` and `sweep.ts`**

Per-route shape table: `batch-why` → `explanations[]`, `batch-relates` → `results[]`, `alignment` → `assessment.insights[]`, `translate` → `translation`. `runSweep` calls `buildPayloads(case, catalogIndex)` from Task 8 for each case, sends `model` and `x-eval-token` on every request, records `latency_ms`, and converts timeouts and non-2xx to a `CallResult` with `error` set. `resolveCodeVersion` shells out to `aws ecs describe-tasks` and returns the container `imageDigest`; any failure returns `null` — the report decides how loudly to say so.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest evaluation/__tests__/route-sweep-checks.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add evaluation/route-sweep/checks.ts evaluation/route-sweep/sweep.ts evaluation/__tests__/route-sweep-checks.test.ts
git commit -m "feat(route-sweep): sweep both models and check each call"
```

---

### Task 10: Render the artifact and the side-by-side

**Files:**
- Create: `evaluation/route-sweep/report.ts`
- Create: `evaluation/__tests__/route-sweep-report.test.ts`

**Interfaces:**
- Consumes: `SweepArtifact`, `CallResult` (Task 7); `checkCall` (Task 9).
- Produces:
  - `export function renderMarkdown(a: SweepArtifact): string`
  - `export function artifactPath(label: string, date?: Date): { json: string; md: string }` — both under `evaluation/baselines/`, named `YYYY-MM-DD-route-sweep-<label>.json|.md`

- [ ] **Step 1: Write the failing test**

```ts
it('names both files under evaluation/baselines with the date and label', ...)
it('puts the mechanical check summary before any model output', ...)
it('prints code version unknown in the header line when it is null', ...)
it('labels a fallback row as not produced, with its reason', ...)
it('shows both models for a case on one screen worth of lines', ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest evaluation/__tests__/route-sweep-report.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `report.ts`**

Header block: label, target, both models, `max_results`, submodule commit, code version (or `unknown` in the same prominent line), and the count of failing checks. Then a per-route section, each case as: the question, then `model A` and `model B` outputs stacked, with the mechanical verdict on the line above them.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest evaluation/__tests__/route-sweep-report.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add evaluation/route-sweep/report.ts evaluation/__tests__/route-sweep-report.test.ts
git commit -m "feat(route-sweep): artifact and side-by-side readout"
```

---

### Task 11: The CLI, the npm script, and the runbook note

**Files:**
- Create: `evaluation/run-route-sweep.ts`
- Modify: `package.json` (add `eval:routes`)
- Modify: `evaluation/README.md` (a short section under Deployed-instance evals)
- Create: `evaluation/__tests__/route-sweep-cli.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 7–10.
- Produces: `export function parseSweepArgs(argv: string[]): { stage: 'freeze' | 'sweep' | 'all'; label: string; evalset: string; limit: number; models: [string, string]; target: string; concurrency: number; timeoutMs: number; token?: string }`

- [ ] **Step 1: Write the failing test**

```ts
it('defaults stage to all, limit 10, concurrency 2, timeout 120000, target qa', ...)
it('requires two distinct models', ...)          // --model-a gpt-5.4-nano --model-b gpt-5.4-nano → throws
it('requires both models to be supplied', ...)
it('rejects a timeout above 300000', ...)        // ALB idle_timeout
it('reads the token from --token or EVAL_MODEL_OVERRIDE_TOKEN', ...)
it('requires a label', ...)                      // artifact filenames are not anonymous
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest evaluation/__tests__/route-sweep-cli.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `evaluation/run-route-sweep.ts`**

`freeze` writes `evaluation/results/route-freeze-<label>.json` using `loadEvalset` + `freezeCases`; `sweep` reads it (or freezes first when `stage` is `all`), resolves the catalog index once with `fetchCatalogIndex`, passes it to `runSweep`, then writes both baseline files and prints the markdown path. Refuse to sweep when a model is missing; print the check summary on exit.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest evaluation/__tests__/route-sweep-cli.test.ts`
Expected: PASS

- [ ] **Step 5: Add the npm script and README section**

```json
"eval:routes": "npx tsx evaluation/run-route-sweep.ts"
```

README: how to run a sweep, what the two artifact files are, that a `produced: false` row is not evidence, and that the tool reports but does not judge.

- [ ] **Step 6: Prove the tool end to end against QA**

```bash
npm run eval:routes -- --label smoke --model-a gpt-5.4-nano --model-b gpt-5.6-luna --limit 2
```

Expected: two files in `evaluation/baselines/`, every row carrying a provenance model, and the console printing the check summary. Record the numbers in the PR description.

- [ ] **Step 7: Commit**

```bash
git add evaluation/run-route-sweep.ts evaluation/__tests__/route-sweep-cli.test.ts package.json evaluation/README.md
git commit -m "feat(route-sweep): CLI and runbook"
```
