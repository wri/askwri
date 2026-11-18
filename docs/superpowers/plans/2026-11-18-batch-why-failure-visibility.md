# batch-why: Make a Failed Reply Say Why — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/api/batch-why` records the provider's `finish_reason` and names a truncated reply `truncated`, so a
length cut-off and a malformed reply stop looking identical; then one probe on the GPT-6 candidate decides
whether the route's token budget needs its own fix.

**Architecture:** The route already holds `data.choices[0].finish_reason` and discards it. Task 1 reads it into
`debug.finish_reason` on every 200 path and sets `provenance.fallback_reason = 'truncated'` when it is
`length` on a failed parse. No behaviour change for users: the canned fallback body stays as is (changing what
the user sees is Task 3, and only if Task 2's evidence demands it). Task 2 spends one live call on
`gpt-6-luna`, the model this route is moving to; `gpt-5.4-*` is retired and is not probed.

**Tech Stack:** TypeScript, Next.js 16 route handler, Jest (`@jest-environment node`).

**Why this scope:** the first QA sweep (`handoffs/2026-11-18-route-sweep-first-run-findings.md`) showed
`batch-why` returning six canned explanations after a parse error, and could not say whether the reply was
truncated or malformed. The cause is unknown; instrumenting the route is model-independent and survives the
migration, so it comes before any guess at a fix.

---

### Task 1: Record `finish_reason`, name truncation

**Files:**
- Modify: `src/app/api/batch-why/route.ts` (after `const data = await response.json()` at ~line 184; the
  `written === 0` return at ~269; the success return at ~282; the `catch (parseError)` return at ~305)
- Test: `src/__tests__/batch-why-route.test.ts` (new `describe` at the end of the file)

**Interfaces:**
- Produces: `debug.finish_reason: string | null` on every 200 response; `provenance.fallback_reason` is
  `'truncated'` (not `'parse_error'`) when parsing failed or yielded no model-written text **and**
  `finish_reason === 'length'`.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/batch-why-route.test.ts`. `chatReply` hard-codes `finish_reason: 'stop'`, so add a
sibling helper next to it (do not change `chatReply`):

```ts
function chatReplyFinishing(content: string, finishReason: string) {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { content } }],
    }),
    { status: 200 },
  )
}

describe('POST /api/batch-why — finish_reason', () => {
  const QUERY = 'How do cities cool streets?'

  it('records finish_reason on a clean reply', async () => {
    const { json } = await post({ query: QUERY, passages: PASSAGES })
    expect(json.debug.finish_reason).toBe('stop')
    expect(json.provenance).toEqual({ model: 'gpt-5-mini', produced: true })
  })

  it('names a cut-off reply truncated, not parse_error', async () => {
    fetchMock.mockResolvedValue(
      chatReplyFinishing('[{"why": "Both measure how shade cools str', 'length'),
    )
    const { json } = await post({ query: QUERY, passages: PASSAGES })
    expect(json.fallback).toBe(true)
    expect(json.explanations).toEqual([CANNED, CANNED])
    expect(json.debug.finish_reason).toBe('length')
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'truncated',
    })
  })

  it('keeps parse_error for a malformed reply that finished normally', async () => {
    fetchMock.mockResolvedValue(chatReplyFinishing('not json at all', 'stop'))
    const { json } = await post({ query: QUERY, passages: PASSAGES })
    expect(json.debug.finish_reason).toBe('stop')
    expect(json.provenance.fallback_reason).toBe('parse_error')
  })

  it('names an all-canned truncated reply truncated too', async () => {
    fetchMock.mockResolvedValue(chatReplyFinishing('[]', 'length'))
    const { json } = await post({ query: QUERY, passages: PASSAGES })
    expect(json.provenance.produced).toBe(false)
    expect(json.provenance.fallback_reason).toBe('truncated')
  })

  it('records null when the provider sends no finish_reason', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'not json' } }] }),
        { status: 200 },
      ),
    )
    const { json } = await post({ query: QUERY, passages: PASSAGES })
    expect(json.debug.finish_reason).toBeNull()
    expect(json.provenance.fallback_reason).toBe('parse_error')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/__tests__/batch-why-route.test.ts -t 'finish_reason'`
Expected: FAIL — `json.debug.finish_reason` is `undefined` (first, third, fifth tests) and
`fallback_reason` is `'parse_error'` where `'truncated'` is expected (second, fourth).

- [ ] **Step 3: Implement**

In `route.ts`, directly after `const data = await response.json()` and its log call, add:

```ts
    const finishReason: string | null =
      data.choices?.[0]?.finish_reason ?? null
    // `length` means the provider stopped at the token cap, so a reply that does
    // not parse is a budget problem, not a malformed-output problem.
    const failureReason = finishReason === 'length' ? 'truncated' : 'parse_error'
```

Then change the three return sites:

1. `written === 0` return: `debug: { parseError: true, rawContent: content.slice(0, 200), finish_reason: finishReason }`
   and `...provenance(model, false, failureReason)`.
2. Success return: `debug: { rawContent: content.slice(0, 200), finish_reason: finishReason }`.
3. `catch (parseError)` return: add `finish_reason: finishReason` to its `debug` and use
   `provenance(model, false, failureReason)`.

- [ ] **Step 4: Run to verify they pass, plus the whole route suite**

Run: `npx jest src/__tests__/batch-why-route.test.ts src/__tests__/route-requests-unchanged.test.ts`
Expected: PASS, no existing assertion edited. If an existing test asserts `debug` with `toEqual`, it will fail
here: update only that `debug` literal to include `finish_reason`, and record a `Ruling:` line in
`.superpowers/sdd/2026-11-18-qa-sweep-and-migration-stages/progress.md`.

- [ ] **Step 5: Gates**

With `.env` moved aside (`mv .env /tmp/envaside` before, back after), as separate commands:
`npx jest --maxWorkers=2`, `npm run lint`, `npm run format:check`, `npx next build --webpack` (retry once on
`SecurityFatalError`; never `next upgrade`).

- [ ] **Step 6: Commit, then read roborev**

```bash
git add src/app/api/batch-why/route.ts src/__tests__/batch-why-route.test.ts
git commit -m "fix(batch-why): record finish_reason, and call a length cut-off truncated"
```

Then `roborev job list`, and read every job for the new SHA. A `Fail` verdict means this task is not done.

---

### Task 2: One probe on the candidate, at the failing shape

**Files:** none (evidence only). Output goes into the PR description and a short note appended to
`docs/superpowers/handoffs/2026-11-18-route-sweep-first-run-findings.md`.

The failing QA case had **6 passages**; `probe:models --task why` carries 25. The probe has no passage-count
flag, so this task first checks whether the 25-passage shape is enough, and only adds a knob if it is not.

- [ ] **Step 1: Run the probe on `gpt-6-luna` at `none`** (reads `.env`; one live call, the project's own tool)

Run: `npm run probe:models -- --task why --models gpt-6-luna`
Expected: a row for `gpt-6-luna` reporting `finish_reason` and reasoning tokens.

- [ ] **Step 2: Read the row and decide**

| Result | Meaning | Next |
|---|---|---|
| `finish_reason: stop`, usable JSON | Luna at `none` completes `why` inside the 3000-token cap | Task 3 not needed; truncation was a 5.4 reasoning-token artefact. Done. |
| `finish_reason: length` | the cap is too small for this model | Task 3 (budget), as its own plan |
| API rejects the request | request-arm defect | stop; write it up, do not patch around it |

- [ ] **Step 3: Record the row** in the findings handoff under a new heading `## Probe on the candidate,
  2026-11-18`, commit as `docs(superpowers): batch-why probe on gpt-6-luna`.

---

### Task 3 (only if Task 2 shows `length`): out of this plan

A budget that accounts for reasoning tokens on the `why` path is a route change with its own gate
(`handoffs/…first-run-findings.md`, "What would decide it"). It gets its own plan, written from Task 2's
measured token counts, not from a guess.

---

## Self-review

- **Spec coverage:** the findings doc asks for (1) `finish_reason` evidence, (3) a route change only after
  that. Task 1 + 2 cover (1); Task 3 is explicitly deferred behind evidence.
- **Placeholders:** none; every code step shows code.
- **Names:** `finishReason`, `failureReason`, `debug.finish_reason` are used identically in tests and
  implementation.
