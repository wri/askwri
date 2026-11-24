# Overview: honest assessment state and tier-consistent counts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the cite-mode Overview from presenting a canned assessment as model output, and make its relevance counts use the same tiers (and therefore the same thresholds) as the results table.

**Architecture:** No route changes. The client learns from `provenance.produced` whether a model wrote the assessment and renders an explicit "unavailable" line instead; the prompt summary counts the `relevance_tier` the search service already stamps on every document, so `0.70 / 0.30` never appears in TypeScript.

**Tech Stack:** Next.js 16 App Router, React, TypeScript, Chakra UI + `@worldresources/wri-design-systems`, Jest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-24-overview-assessment-honesty-design.md`

## Global Constraints

- `provenance.produced === false` is the only gate. `provenance.sanitized` must **not** hide an assessment; it gets a `shortcut:` comment citing #498.
- Exactly one user-facing line, used verbatim wherever the failure is shown:
  `Assessment unavailable — the assessment service didn’t respond for this search. The results below are unaffected.`
- No relevance threshold may appear in TypeScript. `0.70` / `0.30` live only in `search-service/app/config.py`.
- Do not change `/api/alignment`'s request or response contract, its `provenance` fields, or its failure behaviour.
- A failed assessment is never written into `queryCache`.
- Prettier config is authoritative: single quotes, JSX single quotes, no semicolons, `printWidth: 80`.
- Commits go on `fix/overview-provenance-tiers`. Never push or target `main` or `production`; the PR targets `qa`.

## Review Focus

Inputs and conditions the spec implies but whose behaviour no existing test pins. Each gets its test in the task named beside it.

1. **A failing alignment route during a normal search** — the user should see the unavailable line and stay there; the page must not re-call the failing route on its own (that would flicker the line against retries). Task 2.
2. **A repeat query within the 5-minute cache window after a failure** — the aligned docs come back from cache, the assessment is retried, and the line disappears if the retry succeeds. The cache key includes facets, so a test would have to drive two distinct UI paths onto the same entry; this one stays a manual check (Task 4, Step 3) rather than a test that asserts nothing.
3. **Result sets with no `relevance_tier` at all** (reranker off or outage) — the counts must not silently fold untiered documents into "Weak", and must not sum past `Results:`. Task 1.
4. **An assessment a model did produce** (`produced: true`) — no flag, no message; the anti-goal is hiding a good assessment. Task 2 pins the cite path, Task 3 the answer path.
5. **A produced assessment with `sanitized: true`** — still rendered as an assessment (decision 3), so a future "gate on sanitized" change fails loudly here. Task 2.

---

### Task 1: Tier counts in `buildAlignmentSummary`

**Files:**
- Modify: `src/app/utils/utils.tsx` (`buildAlignmentSummary`, ~L322-381)
- Create: `src/__tests__/alignment-summary.test.ts`
- Test: `evaluation/__tests__/route-sweep-payloads.test.ts` (~L14-27 `doc` helper, ~L59-62 `docsAB`, ~L172-183 assertion)

**Interfaces:**
- Consumes: `DocMeta.relevance_tier?: 'strong' | 'partial' | 'weak'` (`src/lib/llamacloud.ts:31`), stamped by the search service from `cite_strong_threshold` / `cite_partial_threshold`.
- Produces: `buildAlignmentSummary(query: string, docs: any[], index?: CatalogIndex | null): string` — signature unchanged. The summary now contains `Results: N. Strong: X. Partial: Y. Weak: Z.` followed by ` Untiered: J.` only when `J > 0`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/alignment-summary.test.ts`:

```ts
import { buildAlignmentSummary } from '@/app/utils/utils'

const doc = (id: string, relevance_tier?: string, score = 0.75) =>
  ({ doc_id: id, title: `title ${id}`, score, relevance_tier, kps: [] }) as any

it('counts the tiers the results table shows, not its own score bands', () => {
  const summary = buildAlignmentSummary('urban heat', [
    doc('a', 'strong', 0.72),
    doc('b', 'strong', 0.95),
    doc('c', 'partial', 0.4),
    doc('d', 'weak', 0.12),
  ])
  expect(summary).toContain('Results: 4. Strong: 2. Partial: 1. Weak: 1.')
  expect(summary).not.toContain('Untiered')
  // The old bands: 0.72 and 0.95 are not "highly relevant" at 0.70 in the UI,
  // and a 0.4 partial is not "moderate" below 0.5.
  expect(summary).not.toContain('Highly relevant')
  expect(summary).not.toContain('Moderately')
})

it('reports documents with no tier as untiered instead of folding them into weak', () => {
  const summary = buildAlignmentSummary('urban heat', [
    doc('a', 'strong'),
    doc('b', undefined, 0.85),
    doc('c', undefined, 0.6),
  ])
  expect(summary).toContain('Results: 3. Strong: 1. Partial: 0. Weak: 0.')
  expect(summary).toContain('Untiered: 2.')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/__tests__/alignment-summary.test.ts`
Expected: FAIL — the summary still says `Highly relevant: …` and has no `Strong:` field.

- [ ] **Step 3: Replace the score bands with tier counts**

In `buildAlignmentSummary`, delete the `highlyRelevant` / `moderatelyRelevant` filters and build a tier tally over `docs`:

```ts
const tiers = { strong: 0, partial: 0, weak: 0 }
for (const d of docs) {
  const tier = d.relevance_tier
  if (tier === 'strong' || tier === 'partial' || tier === 'weak') tiers[tier]++
}
const untiered =
  reviewedCount - tiers.strong - tiers.partial - tiers.weak
```

Then replace the counts segment of `resultsSummaryForAlignment` (leave the `Languages among the results` and `Sample passages` segments exactly as they are):

```ts
`Query: ${query}. Results: ${reviewedCount}. Strong: ${tiers.strong}. Partial: ${tiers.partial}. Weak: ${tiers.weak}.${untiered ? ` Untiered: ${untiered}.` : ''}`
```

Update the function's docstring: the counts come from the search service's tiers (`cite_strong_threshold` 0.70 / `cite_partial_threshold` 0.30 in `search-service/app/config.py`), and untiered documents are reported separately because the reranker did not run.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest src/__tests__/alignment-summary.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Update the route-sweep payload test**

In `evaluation/__tests__/route-sweep-payloads.test.ts`, give the fixture tiers so the counts are non-trivial:

```ts
const doc = (
  docId: string,
  title: string,
  snippet: string,
  relevance_tier?: string,
) => ({ …, relevance_tier, … })   // spread into the existing object literal
```

```ts
const docsAB = () => [
  doc('doc-a', 'title a (native)', 'snippet from A', 'strong'),
  doc('doc-b', 'title b (native)', 'snippet from B', 'partial'),
]
```

And change the asserted prefix to:

```ts
expect(withIndex.resultsSummary).toContain(
  'Query: why does it matter?. Results: 2. Strong: 1. Partial: 1. Weak: 0.',
)
```

- [ ] **Step 6: Run the touched suites**

Run: `npx jest src/__tests__/alignment-summary.test.ts evaluation/__tests__/route-sweep-payloads.test.ts`
Expected: PASS, all tests.

- [ ] **Step 7: Commit**

```bash
git add src/app/utils/utils.tsx src/__tests__/alignment-summary.test.ts evaluation/__tests__/route-sweep-payloads.test.ts
git commit -m "fix(overview): count relevance tiers instead of separate score bands (#498)"
```

---

### Task 2: Cite-mode Overview shows an explicit unavailable state

**Files:**
- Modify: `src/app/results/page.tsx` — state near L49, cache hit ~L224, cache-miss reset ~L231, `runAlignment` ~L409-524, auto-run effect ~L559-581, `CitePanel` props ~L667-681
- Modify: `src/app/results/CitePanel.tsx` — destructure ~L27-40, prop type ~L49-56, pass-through ~L135-145
- Modify: `src/app/components/results/types.ts` (`ResultsPageProps`, ~L59-90)
- Modify: `src/app/components/results/index.tsx` — destructure ~L36-40, Overview body/badge ~L160-205, design-system import at L8-12
- Test: `src/app/components/results/__tests__/ResultsPage.test.tsx`
- Test: `src/__tests__/results-page.test.tsx`

**Interfaces:**
- Consumes: `/api/alignment` body `{ ok, assessment?: { insights: string[], alignment: string }, provenance?: { model: string, produced: boolean, fallback_reason?: string } }`.
- Produces: `alignFailed?: boolean` on `ResultsPageProps` and on `CitePanel`'s props. `true` means "an assessment was attempted or the route answered without one, and none is available".

- [ ] **Step 1: Write the failing component test**

In `src/app/components/results/__tests__/ResultsPage.test.tsx`, add inside a new `describe`:

```tsx
describe('overview — assessment availability', () => {
  const renderWith = (overrides: any) =>
    render(
      <ChakraProvider>
        <ResultsPage {...props({ facets: [] })} {...overrides} />
      </ChakraProvider>,
    )

  it('says the assessment is unavailable instead of showing a rating', () => {
    renderWith({ alignment: null, alignFailed: true })
    expect(screen.getByText(/Assessment unavailable/)).toBeInTheDocument()
    expect(screen.queryByText(/Alignment:/)).not.toBeInTheDocument()
  })

  it('still shows a model-produced assessment, sanitized or not', () => {
    renderWith({
      alignment: { insights: ['Tree canopy studies are direct evidence.'] },
      alignFailed: false,
    })
    expect(
      screen.getByText('Tree canopy studies are direct evidence.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Assessment unavailable/)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/app/components/results/__tests__/ResultsPage.test.tsx -t 'assessment availability'`
Expected: FAIL — no "Assessment unavailable" text exists.

- [ ] **Step 3: Add the prop and the three-way render**

`src/app/components/results/types.ts` — add to `ResultsPageProps`, next to `alignLoading`:

```ts
  /** True when an assessment was attempted and none is available (the route
   *  answered `provenance.produced: false`, or never answered at all). */
  alignFailed?: boolean
```

`src/app/components/results/index.tsx`:

- Destructure `alignFailed` beside `alignLoading`.
- Extend the existing `@worldresources/wri-design-systems` import with `InlineMessage`.
- The Overview body becomes a four-way, keeping the current branches otherwise intact:

```tsx
{alignLoading ? (
  /* existing spinner block, unchanged */
) : alignFailed ? (
  <InlineMessage
    icon=''
    variant='warning'
    label=''
    size='full-width'
    caption='Assessment unavailable — the assessment service didn’t respond for this search. The results below are unaffected.'
  />
) : !alignment || !alignment.insights?.length ? (
  /* the same spinner block as today */
) : (
  /* existing List.Root block, unchanged */
)}
```

- Gate the badge on the flag as well: `{!alignLoading && !alignFailed && alignment?.alignment && (`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest src/app/components/results/__tests__/ResultsPage.test.tsx`
Expected: PASS, including the pre-existing filter tests.

- [ ] **Step 5: Write the failing page tests**

In `src/__tests__/results-page.test.tsx`:

- Add `data-align-failed={String(Boolean(props.alignFailed))}` to the `CitePanel` stub's `<div data-testid='cite-panel' …>`.
- Add a `describe('results page — assessment availability')` with three tests. Each overrides `global.fetch` so `/api/alignment` answers as described and `batch-relates` still returns `{ results: [] }` (mirror the `beforeEach` mock's shape):

```tsx
const alignmentFetch = (body: any) =>
  jest.fn((url: any) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve(
          String(url).includes('batch-relates')
            ? { results: [] }
            : String(url).includes('/api/alignment')
              ? body
              : { ok: false },
        ),
    }),
  ) as any

it('flags the overview unavailable when no model produced the assessment', async () => {
  mockCite.mockResolvedValue(citeResponse([doc('a')]))
  global.fetch = alignmentFetch({
    ok: true,
    assessment: { insights: ['Canned.'], alignment: 'Moderate' },
    provenance: { model: 'm', produced: false, fallback_reason: 'upstream_500' },
  })
  renderPage('cities')
  await waitFor(() =>
    expect(screen.getByTestId('cite-panel')).toHaveAttribute(
      'data-align-failed',
      'true',
    ),
  )
})

it('leaves the overview unflagged when a model produced the assessment', async () => {
  mockCite.mockResolvedValue(citeResponse([doc('a')]))
  global.fetch = alignmentFetch({
    ok: true,
    assessment: { insights: ['Real.'], alignment: 'High' },
    provenance: { model: 'm', produced: true },
  })
  renderPage('cities')
  await waitFor(() =>
    expect(screen.getByTestId('cite-panel')).toHaveAttribute(
      'data-align-failed',
      'false',
    ),
  )
})

it('does not re-call a route that answered with no assessment', async () => {
  mockCite.mockResolvedValue(citeResponse([doc('a')]))
  global.fetch = alignmentFetch({ ok: false })
  renderPage('cities')
  await waitFor(() =>
    expect(screen.getByTestId('cite-panel')).toHaveAttribute(
      'data-align-failed',
      'true',
    ),
  )
  await new Promise((r) => setTimeout(r, 500))
  const calls = (global.fetch as jest.Mock).mock.calls.filter((c) =>
    String(c[0]).includes('/api/alignment'),
  )
  expect(calls).toHaveLength(1)
})
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx jest src/__tests__/results-page.test.tsx -t 'assessment availability'`
Expected: FAIL — `data-align-failed` is absent from the stub.

- [ ] **Step 7: Wire the flag through the page and `CitePanel`**

`src/app/results/page.tsx`:

- `const [alignFailed, setAlignFailed] = useState(false)` beside the `alignment` state.
- Cache-hit restore (~L224): call `setAlignFailed(false)` with `setAlignment(cached.alignment ?? null)`.
- Cache-miss reset (~L231): call `setAlignFailed(false)` with `setAlignment(null)`.
- `runAlignment`:
  - empty-docs early return → `setAlignment(null); setAlignFailed(true)`.
  - success branch condition becomes `if (j?.ok && j?.assessment && j.provenance?.produced !== false)`; inside it, `setAlignFailed(false)` before/after `setAlignment(finalAlignment)`.
  - the existing `else` → `setAlignment(null); setAlignFailed(true)`; the existing cache write stays inside the success branch only.
  - `catch` → `setAlignment(null); setAlignFailed(true)`.
  - Above the success condition, write the decision-3 note: `shortcut: sanitized responses still render as assessments — the flag conflates a coerced rating with a substituted bullet; split it when the substituted insights need their own copy (#498).`
- Auto-run effect (~L559): add `!alignFailed` to the `if` condition and `alignFailed` to the dependency array, with a one-line comment: a failed assessment is not retried by the effect; a new search clears the flag.
- `CitePanel` props: pass `alignFailed={alignFailed}`.

`src/app/results/CitePanel.tsx`: accept `alignFailed?: boolean` in the destructured params and the inline prop type, and pass it to `<ResultsPage … alignFailed={alignFailed} />`.

- [ ] **Step 8: Run the page suite to verify it passes**

Run: `npx jest src/__tests__/results-page.test.tsx`
Expected: PASS, including the existing facet, typo-correction and off-topic-banner tests.

- [ ] **Step 9: Lint and format the touched files**

Run: `npx prettier --check src/app/results/page.tsx src/app/results/CitePanel.tsx src/app/components/results/index.tsx src/app/components/results/types.ts && npx eslint src/app/results/page.tsx src/app/results/CitePanel.tsx src/app/components/results/index.tsx`
Expected: no output from prettier, no eslint errors.

- [ ] **Step 10: Commit**

```bash
git add src/app/results/page.tsx src/app/results/CitePanel.tsx src/app/components/results/index.tsx src/app/components/results/types.ts src/__tests__/results-page.test.tsx src/app/components/results/__tests__/ResultsPage.test.tsx
git commit -m "fix(overview): show an explicit unavailable state when no model produced the assessment (#498)"
```

---

### Task 3: Answer mode never badges an unproduced assessment

**Files:**
- Modify: `src/app/components/AnswerMode/AIResearchModal.tsx` (`runAlignment`, ~L64-92)
- Test: `src/__tests__/answer-mode-e2e.test.tsx` (new `it` inside the existing `describe`)

**Interfaces:**
- Consumes: the same `/api/alignment` response shape as Task 2 (`provenance.produced`).
- Produces: nothing new — answer mode's only alignment surface is the badge in `AnswerPanel.tsx` (~L283-296), which already renders `null` when `alignment` is `null`.

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/answer-mode-e2e.test.tsx`, modelled on the existing full-flow test but with `/api/alignment` answering `produced: false`:

```tsx
it('shows no alignment badge when no model produced the assessment', async () => {
  const query = 'How do cities cut emissions?'
  const doc = {
    doc_id: 'doc-1',
    ref: 'doc-1',
    title: 'Urban Climate Action',
    year: 2025,
    kps: [
      {
        kp_relevance: 0.9,
        snippet: 'Compact growth reduces emissions.',
        passage_id: 'passage-7',
        page: 4,
        citation_targets: [],
      },
    ],
  }
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/llamaindex')
      return jsonResponse({ docs: [doc], usage: null, debug: {}, likely_off_topic: false })
    if (url === '/api/answer')
      return jsonResponse({ ok: true, synthesis: { sentences: ['Answer.'], cites: [[1]] }, passages_sent: [] })
    if (url === '/api/alignment')
      return jsonResponse({
        ok: true,
        assessment: { insights: ['Canned.'], alignment: 'Moderate' },
        provenance: { model: 'm', produced: false, fallback_reason: 'upstream_500' },
      })
    if (url === '/api/answer-mode-query-logs') return jsonResponse({ ok: true })
    if (url === '/api/batch-why') return jsonResponse({ ok: true, explanations: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  })

  render(
    <ChakraProvider>
      <AIResearchModal open />
    </ChakraProvider>,
  )
  fireEvent.change(screen.getByLabelText('Search query input'), {
    target: { value: query },
  })
  fireEvent.click(screen.getByLabelText('Submit search query'))

  await screen.findByText('Answer.')
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/alignment')).toBe(true),
  )
  expect(screen.queryByText(/Alignment:/)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/__tests__/answer-mode-e2e.test.tsx -t 'no alignment badge'`
Expected: FAIL — `Alignment: Moderate` is on screen.

- [ ] **Step 3: Treat an unproduced assessment as no assessment**

In `AIResearchModal.tsx`'s `runAlignment`, change the acceptance condition to:

```ts
if (j?.ok && j?.assessment && j.provenance?.produced !== false) {
```

and add a comment above it: the route answers `ok: true` with a canned assessment on every failure, so `produced: false` means no badge. The existing `else` already clears the state.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest src/__tests__/answer-mode-e2e.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/components/AnswerMode/AIResearchModal.tsx src/__tests__/answer-mode-e2e.test.tsx
git commit -m "fix(answer-mode): no alignment badge for an assessment no model produced (#498)"
```

---

### Task 4: Whole-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full suite**

Run: `npx jest`
Expected: same shape as the branch baseline — 106+ suites passing, 22 DB suites skipped, 0 failures.

- [ ] **Step 2: Format check the repository**

Run: `npx prettier --check .`
Expected: no output.

- [ ] **Step 3: Report**

Report the suite counts, the three commit SHAs, and the manual check from the spec: with `OPENAI_API_KEY` unset (or a stubbed 500), a cite-mode query shows the unavailable line and no badge, and the same query re-run retries the assessment.
