# Flag-on vs flag-off measurement on QA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a recorded, reproducible comparison of QA's query-understanding flags on versus off, on the current evalsets and models, with a go/no-go memo for promoting them to production.

**Architecture:** One opt-in lever in the eval harness (`EVAL_EXPANSION=off` → `expansion: false` in the gateway request), a 12-run matrix against the deployed QA, and a baseline document that carries every fact needed to interpret it three months from now. No search-service change, no flag flip, no redeploy.

**Tech Stack:** TypeScript + tsx, Jest, the gen-2 eval harness (`evaluation/run-evalset.ts`), the `eval-review` evalset submodule.

**Spec:** `docs/superpowers/specs/2026-11-24-flag-on-vs-off-measurement-design.md`

## Global Constraints

- A run with `EVAL_EXPANSION` unset must send **exactly** `{query, mode}` — `evaluation/README.md` requires that a plain run sends no retrieval params, so defaults must not drift.
- `EVAL_EXPANSION` accepts `off` and `on` only. Any other value fails fast: a typo must never silently produce a default-arm run that gets recorded as a comparison.
- The off arm must be visible in three places: the run header, the report JSON, and the baseline document.
- Nothing under `search-service/` or `terraform/` changes. No flag is flipped anywhere.
- The measured target is the deployed QA at app commit `4b3a05e` (from the QA task definition's image tag). If the target is not that commit when the runs start, stop and record the actual commit instead.
- Never print a secret. The task definitions and any `.env` file hold keys; read names, not values.

## Review Focus

Inputs and conditions most likely to make this measurement lie. Each gets its test or its explicit sentence in the baseline.

1. **An env value typo (`EVAL_EXPANSION=Of`, `=false`, `=0`)** — silently doing nothing would produce two identical arms recorded as a comparison. Must fail fast. Task 1.
2. **The default arm drifting** — any future edit that adds a param to the plain request breaks the README's contract and invalidates every historical baseline. Task 1 pins the exact body.
3. **The off arm not actually being flag-off** — if `expansion: false` were dropped in transit, both arms measure the same thing and the comparison reads as "flags do nothing". Task 2 checks the target's own `debug` output for the arm.
4. **Recording a run whose provenance cannot be reconstructed** — missing target commit, fixtures commit, or model settings. Task 2's baseline carries all of them.
5. **Reading a cached sidecar result as model stability** — `lru_cache` makes repeat runs identical within a deploy. The baseline must say this where the spread is reported, not bury it. Task 2.

---

### Task 1: The flag-off lever

**Files:**
- Create: `evaluation/lib/gateway-body.ts`
- Test: `evaluation/__tests__/gateway-body.test.ts`
- Modify: `evaluation/run-evalset.ts` (`queryTarget` ~L225-240, the report object ~L630-645, the header ~L746-756)

**Interfaces:**
- Produces: `gatewayBody(query: string, mode: 'cite' | 'answer'): Record<string, unknown>` — the request body for `POST {TARGET}/api/llamaindex`. Unset/`on` → `{query, mode}`; `off` → `{query, mode, expansion: false}`. Throws `Error` on any other `EVAL_EXPANSION` value.
- Produces: `expansionArm(): 'on' | 'off'` — the arm label, for the header and the report; same validation.

- [ ] **Step 1: Write the failing test**

Create `evaluation/__tests__/gateway-body.test.ts`:

```ts
import { gatewayBody, expansionArm } from '../lib/gateway-body'

const ENV = { ...process.env }
afterEach(() => {
  process.env = { ...ENV }
})

it('sends no retrieval params when no arm is asked for', () => {
  delete process.env.EVAL_EXPANSION
  expect(gatewayBody('hydrogen buses', 'cite')).toEqual({
    query: 'hydrogen buses',
    mode: 'cite',
  })
  expect(expansionArm()).toBe('on')
})

it('sends expansion:false for the flag-off arm', () => {
  process.env.EVAL_EXPANSION = 'off'
  expect(gatewayBody('hydrogen buses', 'cite')).toEqual({
    query: 'hydrogen buses',
    mode: 'cite',
    expansion: false,
  })
  expect(expansionArm()).toBe('off')
})

it('sends the plain body for an explicit on', () => {
  process.env.EVAL_EXPANSION = 'on'
  expect(gatewayBody('hydrogen buses', 'answer')).toEqual({
    query: 'hydrogen buses',
    mode: 'answer',
  })
})

it('fails fast on any other value rather than running a default-arm comparison', () => {
  for (const bad of ['Of', 'false', '0', 'OFF ']) {
    process.env.EVAL_EXPANSION = bad
    expect(() => expansionArm()).toThrow(/EVAL_EXPANSION/)
  }
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest evaluation/__tests__/gateway-body.test.ts`
Expected: FAIL — `Cannot find module '../lib/gateway-body'`.

- [ ] **Step 3: Implement the module**

`evaluation/lib/gateway-body.ts`: read `process.env.EVAL_EXPANSION` at call time (not module load — the test sets it per case). `undefined`/`'on'` → arm `'on'`; `'off'` → arm `'off'`; anything else → `throw new Error('EVAL_EXPANSION must be "on" or "off", got "<value>" — an unrecognised arm would record a default run as a comparison')`. `gatewayBody` returns `{query, mode}` plus `expansion: false` for the off arm. Comment the README contract on the plain path.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest evaluation/__tests__/gateway-body.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into the harness**

In `evaluation/run-evalset.ts`:
- `queryTarget` builds its body with `gatewayBody(question, mode)`.
- The header block in `main()` (beside `Target:`/`Backend:`/`Corpus:`) prints `Expansion: ${expansionArm()}` — always, so every run states its arm.
- The `report` object in `runEvalset` gains `expansion_arm: expansionArm()`.

- [ ] **Step 6: Run the harness suites**

Run: `npx jest evaluation/`
Expected: PASS, no network — the suite has no test that calls the deployed target.

- [ ] **Step 7: Commit**

```bash
git add evaluation/lib/gateway-body.ts evaluation/__tests__/gateway-body.test.ts evaluation/run-evalset.ts
git commit -m "feat(eval): flag-off arm for the query-understanding comparison (#498)"
```

---

### Task 2: Run the matrix and record the baseline

**Files:**
- Create: `evaluation/baselines/2026-11-24-flag-on-vs-off-qa.md`

**Interfaces:**
- Consumes: `EVAL_EXPANSION` from Task 1; the evalsets in `evaluation/eval-review/evalsets/` (11 cases in `evalset_cite_01.json`, 16 in `evalset_cite_02.json`).

- [ ] **Step 1: Record the run context before running anything**

Collect and keep: `git -C evaluation/eval-review rev-parse HEAD` (fixtures pin), the QA task definition image tag (`aws ecs describe-task-definition` on the newest `askwri-app-qa` family → the commit the target is actually running), `curl -s $TARGET/api/llamaindex` (returns `keyword_backend`, `retrieval_backend`, `environment`), the corpus size the harness prints, and the search-service models from `search-service/app/config.py` (`query_understanding_llm_model`, `query_translation_model`).

- [ ] **Step 2: Run the matrix — twelve runs**

For each of `evalset_cite_01.json` and `evalset_cite_02.json`, for each arm (`on`, `off`), three times:

```bash
npx tsx evaluation/run-evalset.ts evaluation/eval-review/evalsets/evalset_cite_01.json
EVAL_EXPANSION=off npx tsx evaluation/run-evalset.ts evaluation/eval-review/evalsets/evalset_cite_01.json
```

Each run writes `evaluation/results/evalset-<name>-<ts>.json` and prints MAP, chunk MAP/recall, latency, cost and the abstain line. Keep every report file; the baseline cites their timestamps.

- [ ] **Step 3: Confirm the two arms really differ**

The harness does not persist `query_understanding`, so check the lever against the service directly: send
one query to `POST /api/llamaindex` twice (with and without `expansion: false`) and compare `usage.calls` — the
on arm carries a `query_understanding` entry, the off arm has none. Also check the abstain signal on a
negative case (on: it can fire; off: `likely_off_topic` is hard-wired false). If the two requests look
identical, stop: the lever is not reaching the service, and no comparison can be recorded.

- [ ] **Step 4: Write the baseline document**

`evaluation/baselines/2026-11-24-flag-on-vs-off-qa.md`, per `evaluation/README.md`'s requirements (target, backend + corpus size, fixtures commit, app commit live on target, model settings, headline numbers per set), containing:
- a table per set: arm × run, doc MAP, chunk MAP, chunk recall, service p50/p95, cost;
- the mean and observed spread per arm, with the `lru_cache` sentence from Review Focus 5 wherever the spread is discussed;
- the abstain counts per arm (the off arm should never flag off-topic — that is production's behaviour today);
- the commands to reproduce it.

- [ ] **Step 5: Write the go/no-go memo at the end of the baseline**

Decide against this table. **Revision note: this table was written after the first run's numbers were
read**, to close an overlap in the original three bullets (a set losing more than 1.0 pp *and* the sets
disagreeing matched two different verdicts). The runs that produced the recorded baseline were governed by
the original bullets, which the baseline quotes verbatim; this table governs future runs. **Unit: percentage points (pp) of doc MAP**, as
printed by the harness. **"Disagree"** means exactly one set's doc-MAP delta is below −1.0 pp and the other's is
not. Every combination maps to exactly one verdict:

| cite_01 Δ (pp) | cite_02 Δ (pp) | service p95 growth | Verdict |
|---|---|---|---|
| ≥ −1.0 | ≥ −1.0 | < +1.5 s | **Promote** |
| ≥ −1.0 | ≥ −1.0 | ≥ +1.5 s | **Hold** — quality is fine, cost is not; measure per-component |
| < −1.0 | ≥ −1.0 | any | **Narrower promotion** (sets disagree) |
| ≥ −1.0 | < −1.0 | any | **Narrower promotion** (sets disagree) |
| < −1.0 | < −1.0 | any | **Hold** |

The 1.0 pp bar is a judgement, not a measured noise floor: repeats within a deployment are served from the
`lru_cache`d sidecar, so they give no variance estimate at all. The determinism probe measures variance in the
sidecar's *inputs*, not in MAP.

Record which row was hit and what it implies for item 9.

- [ ] **Step 6: Commit**

```bash
git add evaluation/baselines/2026-11-24-flag-on-vs-off-qa.md
git commit -m "docs(eval): flag-on vs flag-off baseline on qa, with promotion memo (#498)"
```

---

### Task 3: Whole-suite verification

**Files:** none.

- [ ] **Step 1:** `npx jest` — the full suite, same shape as the branch baseline (107 suites / 1330 tests passing at `4b3a05e`, 22 DB suites skipped).
- [ ] **Step 2:** `npx prettier --check .` — clean.
- [ ] **Step 3:** Report the four commit SHAs, the run timestamps, the memo verdict, and — if it was not run — the item 8b sidecar probe with the reason (no `OPENAI_API_KEY` available to this session).
