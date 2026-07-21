# Review Throughput Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bulk Promote/Re-ingest from the review queue, plus a guided "review bar" on the document editor that walks the queue without round-trips.

**Architecture:** Two admin pages change; one small component is added. The queue page (`src/app/admin/review/page.tsx`) copies the documents page's checkbox-selection pattern and adds a bulk bar that loops the existing per-document endpoints client-side. A new `ReviewBar` component (self-contained: fetches the queue, computes position, navigates) renders at the top of the editor whenever the open doc is in the queue. The editor's Lifecycle panel moves to the top. No new backend endpoints, no schema changes.

**Tech Stack:** Next.js 16 App Router client components, existing `adminFetch` helper, Jest (jsdom).

**Spec:** `docs/superpowers/specs/2026-07-09-review-throughput-design.md`

---

## Context for the implementer (read first)

**Repo rules (executors do NOT inherit CLAUDE.md — restated here):**
- React components are **arrow functions** (eslint `react/function-component-definition`).
- Admin UI style: plain inline styles + Chakra `Box/Heading/Text`, `adminFetch` from `src/app/admin/lib/api.ts`, native `title` tooltips, `window.confirm` for confirmations.
- `npx prettier --write` on touched files before every commit; `npm run lint` stays clean.
- **Never add Co-Authored-By trailers to commits.**
- Targeted tests: `npm test -- --testPathPattern='<name>'`.

**API facts (verified):**
- `GET /api/admin/review-queue` → `{ ok: true, items: ReviewQueueItem[] }`, ordered `created_at DESC`, no pagination — `items.length` is the true M. Item fields: `id, externalId, title, language, status, extractionConfidence, jobStatus, jobError, jobAttempts, suggestedTagCount, createdAt`. Membership predicate: `d.status IN ('needs_review','error') OR latest job errored` — a just-promoted doc can transiently remain in a refetch via a stale errored-job row, so **a successful action response is authoritative for advancing**, never queue membership.
- `POST /api/admin/documents/[id]/status` body `{status:'searchable'}` → 200 `{ok:true,…}`; 400 `can only promote needs_review → searchable` for error/draft docs; promote is editor-accessible (no admin gate).
- `POST /api/admin/documents/[id]/reingest` → 200 `{ok:true,jobId}`; **409** `an open ingestion job already exists` is the realistic bulk failure.
- `adminFetch` throws `Error(body.error || 'HTTP <status>')` on failure and self-redirects on 401 — bulk loops just catch and collect `err.message` per id.

**Existing patterns to copy:**
- Checkbox selection + bulk bar: `src/app/admin/documents/page.tsx` — `selected: Set<string>` state (~line 56), `toggleSelect`/`toggleAll` (~160-175), conditional bulk bar (~311-352), checkbox `<th>/<td>` as first column (~361-393).
- Review page structure: state at `review/page.tsx:57-61` (`items`, `health`, `notice`, `error`, `busyId`), `load()` at 63-75, `act(id, action)` at 82-109, table at 294-380, bulk-bar insertion slot is between the notice/error block (~276-281) and the "Documents needing review" heading (~284-286).
- Editor: sections run Metadata (412-521) → Source metadata (526-565) → Tags (569-665) → Summaries (670-731) → **Lifecycle (733-866)** → Collections (869-924). `load()` at 153-176; `me.role` via plain `fetch('/api/admin/auth/me')` at 187-190.
- Editor test mocks: `src/__tests__/admin-editor.test.tsx` — `setupFetchMock(documentOverride?)` (~72-111) switch-dispatches on URL; default fallback returns `{ok:true}` (no `items`), so **ReviewBar must default to `body.items ?? []`** and existing tests stay green (bar hidden). `next/navigation` is mocked at the top of the file (`useParams → {id:'test-doc-id-123'}`, `useRouter`).
- No component test exists for the review page — create one modeled on `src/__tests__/admin-collections-page.test.tsx` (fixture array, single `global.fetch` mock keyed by URL, render inside `ChakraProvider`, assert via `waitFor`/`screen`).

**Out of scope (spec non-goals):** the per-row Promote/Re-ingest buttons keep current behavior (no error-status gating there); no queue-row redesign; no locking; no bulk endpoint.

---

### Task 1: Review queue — selection, bulk bar, Start reviewing

**Files:**
- Modify: `src/app/admin/review/page.tsx`
- Test: `src/__tests__/admin-review-page.test.tsx` (create)

- [ ] **Step 1: Write the failing tests.** Create `src/__tests__/admin-review-page.test.tsx` modeled on `admin-collections-page.test.tsx` (same navigation mock + ChakraProvider render). Fixture: three queue items — two `status:'needs_review'` (ids `d1`,`d2`), one `status:'error'` (id `d3`) — and a corpus-health body. **The health fixture must be complete** — the page dereferences `workerStyle!.color` once `health` is truthy — minimum shape: `{ ok: true, health: { statusCounts: {}, languageCounts: {}, reviewQueueDepth: 3, docsMissingNativeSummary: 0, docsMissingTitleEn: 0, lowConfidenceDocs: 0, worker: { status: 'idle', queueDepth: 0, intakeBacklog: 0, lastProcessedAt: null } } }`. Mock `global.fetch` keyed by URL (`/api/admin/review-queue`, `/api/admin/corpus-health`, `/api/admin/documents/<id>/status`, `/api/admin/documents/<id>/reingest`). Tests:

```tsx
it('renders a checkbox per row and a select-all header checkbox', async () => { /* 3 row boxes + 1 header box */ })

it('shows the bulk bar only when rows are selected', async () => {
  // no bar initially; check d1 → bar shows "1 selected" with Promote/Re-ingest buttons
})

it('bulk-promotes selected rows after confirm and reports the summary', async () => {
  window.confirm = jest.fn(() => true)
  // select d1+d2, click "Promote 2" → confirm called with text containing "2";
  // fetchMock got POST /documents/d1/status and /documents/d2/status with {status:'searchable'};
  // notice contains "2 promoted"
})

it('keeps failed rows selected and lists reasons on partial failure', async () => {
  // status mock: d1 → {ok:true}, d2 → 409-style {ok:false,error:'an open ingestion job already exists'} via re-ingest OR 400 via promote
  // after bulk: notice/error mentions the failing title + reason; d2 checkbox still checked, d1 unchecked
})

it('disables bulk Promote when the selection includes an error-status doc', async () => {
  // select d3 → "Promote" button disabled with a title explaining why; Re-ingest stays enabled
})

it('renders a Start reviewing button linking to the first queue doc', async () => {
  // link "Start reviewing (3)" with href /admin/documents/d1
})
```

- [ ] **Step 2: Run to verify they fail.** `npm test -- --testPathPattern='admin-review-page'` → FAIL (no checkboxes/bar/button yet).

- [ ] **Step 3: Implement in `review/page.tsx`.**

Add state + helpers (copy the documents-page pattern):

```tsx
const [selected, setSelected] = useState<Set<string>>(new Set())
const [bulkBusy, setBulkBusy] = useState(false)

const toggleSelect = (id: string) =>
  setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

const toggleAll = () =>
  setSelected((prev) =>
    prev.size === items.length ? new Set() : new Set(items.map((i) => i.id)),
  )
```

Bulk handler (one function, parameterized like the existing `act`):

```tsx
const bulkAct = async (action: 'promote' | 'reingest') => {
  const ids = Array.from(selected)
  if (
    !window.confirm(
      action === 'promote'
        ? `Promote ${ids.length} document(s) to public search?`
        : `Re-ingest ${ids.length} document(s)? AI summaries and AI-extracted metadata will be regenerated.`,
    )
  )
    return
  setBulkBusy(true)
  setNotice(null)
  setError(null)
  const failures: { id: string; reason: string }[] = []
  await Promise.allSettled(
    ids.map(async (id) => {
      try {
        if (action === 'promote') {
          await adminFetch(`/api/admin/documents/${id}/status`, {
            method: 'POST',
            body: JSON.stringify({ status: 'searchable' }),
          })
        } else {
          await adminFetch(`/api/admin/documents/${id}/reingest`, { method: 'POST' })
        }
      } catch (err: any) {
        failures.push({ id, reason: err.message })
      }
    }),
  )
  const ok = ids.length - failures.length
  if (failures.length === 0) {
    setNotice(`${ok} ${action === 'promote' ? 'promoted' : 're-queued'}.`)
  } else {
    const titleOf = (id: string) =>
      items.find((i) => i.id === id)?.title ?? items.find((i) => i.id === id)?.externalId ?? id
    setError(
      `${ok} ${action === 'promote' ? 'promoted' : 're-queued'}, ${failures.length} failed — ` +
        failures.map((f) => `${titleOf(f.id)}: ${f.reason}`).join(' · '),
    )
  }
  setSelected(new Set(failures.map((f) => f.id))) // failed rows stay selected
  await load() // single refetch for the whole batch
  setBulkBusy(false)
}
```

Bulk bar JSX (insert between the notice/error block and the "Documents needing review" heading; `selectionHasError` gates Promote):

```tsx
{selected.size > 0 && (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: '8px 12px', background: '#f0f8ff', borderRadius: 4 }}>
    <Text>{selected.size} selected</Text>
    <button
      onClick={() => bulkAct('promote')}
      disabled={bulkBusy || selectionHasError}
      title={
        selectionHasError
          ? 'Selection includes a document with status "error" — those must be re-ingested before they can be promoted.'
          : 'Send the selected documents to the public search corpus.'
      }
      style={{ textDecoration: 'underline' }}
    >
      Promote {selected.size}
    </button>
    <button
      onClick={() => bulkAct('reingest')}
      disabled={bulkBusy}
      title='Re-queue the selected documents for the ingestion pipeline.'
      style={{ textDecoration: 'underline' }}
    >
      Re-ingest {selected.size}
    </button>
  </div>
)}
```

with, above the return:

```tsx
const selectionHasError = items.some((i) => selected.has(i.id) && i.status === 'error')
```

Table changes: add a first `<th>` with the select-all checkbox (`checked={selected.size === items.length && items.length > 0}`, `onChange={toggleAll}`) and a first `<td>` per row (`checked={selected.has(item.id)}`, `onChange={() => toggleSelect(item.id)}`) — exact markup pattern at `documents/page.tsx:361-393`.

Start-reviewing button (next to the "Documents needing review" heading, only when `items.length > 0`; plain `Link`, no router needed):

```tsx
<Link
  href={`/admin/documents/${items[0].id}`}
  style={{ textDecoration: 'underline', fontSize: 14, marginLeft: 12 }}
  title='Open the first flagged document. A review bar on the editor walks you through the rest.'
>
  Start reviewing ({items.length}) →
</Link>
```

- [ ] **Step 4: Run tests.** `npm test -- --testPathPattern='admin-review-page'` → PASS.
- [ ] **Step 5: Lint + format + commit.**

```bash
npx eslint src/app/admin/review/page.tsx src/__tests__/admin-review-page.test.tsx
npx prettier --write src/app/admin/review/page.tsx src/__tests__/admin-review-page.test.tsx
git add src/app/admin/review/page.tsx src/__tests__/admin-review-page.test.tsx
git commit -m "feat(admin): review queue bulk promote/re-ingest with partial-failure reporting"
```

---

### Task 2: ReviewBar component + editor integration

**Files:**
- Create: `src/app/admin/components/ReviewBar.tsx`
- Modify: `src/app/admin/documents/[id]/page.tsx` (render the bar above the page heading)
- Test: `src/__tests__/admin-editor.test.tsx` (extend)

- [ ] **Step 1: Write the failing tests** in `admin-editor.test.tsx`. Two test-infrastructure changes first:

**(a) Capturable router spy.** The file's current `next/navigation` mock returns a fresh `jest.fn()` from every `useRouter()` call — nothing to assert against. Restructure to a hoisted spy (the `mock` name prefix is required for Jest to allow the out-of-scope reference inside the hoisted factory):

```tsx
const mockRouterPush = jest.fn()
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'test-doc-id-123' }),
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), refresh: jest.fn() }),
  // …keep the file's OTHER existing mocked members (useParams/usePathname/useSearchParams) exactly as they are — only `push` changes to the shared spy
}))
```

and add `mockRouterPush.mockClear()` in a `beforeEach`.

**(b) Imports:** add `within` to the `@testing-library/react` import (currently `render, screen, waitFor, fireEvent`).

Then extend `setupFetchMock` so `/api/admin/review-queue` returns a configurable list (add a second optional param, default `[]` → existing tests unaffected):

```tsx
const setupFetchMock = (documentOverride?: Record<string, any>, queueItems: any[] = []) => { … case '/api/admin/review-queue': return { ok: true, items: queueItems } … }
```

New tests (the fixture doc id is `test-doc-id-123`; `mockRouterPush` is the existing `useRouter` mock's `push` spy — capture it):

```tsx
it('shows no review bar when the doc is not in the review queue', async () => {
  setupFetchMock()
  render(…)
  await screen.findByText('Document editor')
  expect(screen.queryByText(/Reviewing \d+ of \d+/)).not.toBeInTheDocument()
})

it('shows position and controls when the doc is in the queue', async () => {
  setupFetchMock({ status: 'needs_review' }, [
    { id: 'other-1', status: 'needs_review' },
    { id: 'test-doc-id-123', status: 'needs_review' },
    { id: 'other-2', status: 'needs_review' },
  ])
  render(…)
  expect(await screen.findByText('Reviewing 2 of 3 flagged')).toBeInTheDocument()
  // Prev enabled (not first), Skip enabled (not last)
})

it('advances to the next queue doc after Promote succeeds', async () => {
  // same 3-item queue; click the bar's Promote → POST …/status fired →
  // expect(mockRouterPush).toHaveBeenCalledWith('/admin/documents/other-2')
})

it('Skip navigates without acting', async () => {
  // click Skip → router.push('/admin/documents/other-2'); no POST to /status or /reingest
})

it('disables Prev at the first position and Skip at the last', async () => {
  // queue [test-doc-id-123] alone → both disabled; Promote still enabled
})

it('shows the not-in-queue notice with a Next button when the queue has other docs but not this one', async () => {
  setupFetchMock({ status: 'searchable' }, [{ id: 'other-1', status: 'needs_review' }])
  // bar renders "No longer in the review queue" + Next → router.push('/admin/documents/other-1')
})
```

Note: the bar's Promote/Re-ingest buttons duplicate labels that exist in the lifecycle panel — scope queries to the bar (e.g. `within(screen.getByTestId('review-bar'))`); give the bar container `data-testid='review-bar'`.

- [ ] **Step 2: Run to verify the new tests fail.** `npm test -- --testPathPattern='admin-editor'` → new FAIL, existing PASS.

- [ ] **Step 3: Write the component** — self-contained; the editor only mounts it:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { adminFetch } from '../lib/api'

interface QueueRef {
  id: string
  status: string
}

/**
 * ReviewBar — pinned guided-pass controls shown on the document editor
 * whenever the open document is currently in the review queue. Fetches the
 * queue itself; a successful action response is authoritative for advancing
 * (queue refetches can transiently still contain a just-promoted doc via a
 * stale errored-job row).
 */
export const ReviewBar = ({
  documentId,
  documentStatus,
  onChanged,
}: {
  documentId: string
  documentStatus: string | undefined
  onChanged: () => void
}) => {
  const router = useRouter()
  const [queue, setQueue] = useState<QueueRef[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    adminFetch<{ items?: QueueRef[] }>('/api/admin/review-queue')
      .then((body) => setQueue(body.items ?? []))
      .catch(() => setQueue([])) // bar is best-effort; never block the editor
  }, [documentId])

  const idx = queue ? queue.findIndex((q) => q.id === documentId) : -1
  const nextId = queue && idx >= 0 && idx < queue.length - 1 ? queue[idx + 1].id : null
  const prevId = queue && idx > 0 ? queue[idx - 1].id : null

  const advance = useCallback(() => {
    if (nextId) router.push(`/admin/documents/${nextId}`)
    else onChanged() // last doc: stay, refresh the editor's stale detail
  }, [nextId, router, onChanged])

  const act = async (action: 'promote' | 'reingest') => {
    setBusy(true)
    setError(null)
    try {
      if (action === 'promote') {
        await adminFetch(`/api/admin/documents/${documentId}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'searchable' }),
        })
      } else {
        await adminFetch(`/api/admin/documents/${documentId}/reingest`, { method: 'POST' })
      }
      advance() // success is authoritative — advance regardless of queue staleness
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (queue === null || (queue.length === 0 && idx < 0)) return null

  const barStyle: React.CSSProperties = {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    background: '#1a365d',
    color: '#fff',
    padding: '8px 16px',
    marginBottom: 16,
    borderRadius: 4,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    fontSize: 14,
  }
  const btn: React.CSSProperties = {
    color: '#fff',
    textDecoration: 'underline',
    cursor: 'pointer',
  }

  if (idx < 0) {
    // Doc left the queue (promoted elsewhere / restored) but a pass is in progress.
    return (
      <div style={barStyle} data-testid='review-bar'>
        <span>No longer in the review queue.</span>
        {queue.length > 0 && (
          <button style={btn} onClick={() => router.push(`/admin/documents/${queue[0].id}`)}>
            Next →
          </button>
        )}
      </div>
    )
  }

  return (
    <div style={barStyle} data-testid='review-bar'>
      <span>
        Reviewing {idx + 1} of {queue.length} flagged
      </span>
      {error && <span style={{ color: '#feb2b2' }}>{error}</span>}
      <span style={{ display: 'flex', gap: 12 }}>
        <button
          style={btn}
          disabled={busy || !prevId}
          onClick={() => prevId && router.push(`/admin/documents/${prevId}`)}
        >
          ← Prev
        </button>
        <button
          style={{ ...btn, fontWeight: 700 }}
          disabled={busy || documentStatus === 'error'}
          title={
            documentStatus === 'error'
              ? 'This document errored during ingestion — re-ingest it before promoting.'
              : 'Promote to public search and move to the next flagged document.'
          }
          onClick={() => act('promote')}
        >
          Promote
        </button>
        <button
          style={btn}
          disabled={busy}
          title='Re-run the ingestion pipeline and move to the next flagged document.'
          onClick={() => act('reingest')}
        >
          Re-ingest
        </button>
        <button style={btn} disabled={busy || !nextId} onClick={advance}>
          Skip →
        </button>
      </span>
    </div>
  )
}

export default ReviewBar
```

Editor integration (`documents/[id]/page.tsx`): import and render immediately above the "Document editor" heading:

```tsx
import { ReviewBar } from '../../components/ReviewBar'
…
<ReviewBar
  documentId={id}
  documentStatus={doc?.status}
  onChanged={() => load({ resetForm: true }).catch((err: any) => setError(err.message))}
/>
```

- [ ] **Step 4: Run tests.** `npm test -- --testPathPattern='admin-editor'` → ALL pass (12 existing + 6 new).
- [ ] **Step 5: Lint + format + commit.**

```bash
npx eslint src/app/admin/components/ReviewBar.tsx 'src/app/admin/documents/[id]/page.tsx' src/__tests__/admin-editor.test.tsx
npx prettier --write src/app/admin/components/ReviewBar.tsx 'src/app/admin/documents/[id]/page.tsx' src/__tests__/admin-editor.test.tsx
git add src/app/admin/components/ReviewBar.tsx 'src/app/admin/documents/[id]/page.tsx' src/__tests__/admin-editor.test.tsx
git commit -m "feat(admin): guided review bar on the editor (walks the review queue, advances on action)"
```

---

### Task 3: Move the Lifecycle panel to the top of the editor

**Files:**
- Modify: `src/app/admin/documents/[id]/page.tsx`
- Test: `src/__tests__/admin-editor.test.tsx` (one new test)

- [ ] **Step 1: Write the failing test.** The spec's approved order is lifecycle → metadata → tags → summaries → source metadata → collections, so assert the full sequence (Source metadata's `<summary>` isn't a heading role — assert via text order):

```tsx
it('renders panels in the approved order (Lifecycle first, Source metadata after Summaries)', async () => {
  setupFetchMock() // fixture doc must include sourceMetadata (add to the fixture if absent)
  render(…)
  await screen.findByText('Document editor')
  const markers = ['Lifecycle', 'Metadata', 'Tags', 'Summaries', 'Original imported metadata (read-only)', 'Collections']
  const text = document.body.textContent ?? ''
  const idxs = markers.map((m) => text.indexOf(m))
  expect(idxs.every((v) => v >= 0)).toBe(true)
  expect([...idxs].sort((a, b) => a - b)).toEqual(idxs) // first occurrences appear in the approved order
})
```

- [ ] **Step 2: Run to verify it fails.** `npm test -- --testPathPattern='admin-editor'` → the new test FAILS.
- [ ] **Step 3: Move TWO sections** (locate by their comments, don't trust line numbers):
  1. Cut the Lifecycle block — `{/* Lifecycle panel */}` comment + its `<section>…</section>` — and paste it directly after the notice/error banners, before the `{/* Metadata panel */}` comment.
  2. Cut the Source-metadata block — its comment + `<section>…</section>` (the `<details>` with "Original imported metadata (read-only)") — and paste it after the Summaries section, before the Collections section.

No content changes. Resulting order: ReviewBar → heading → notices → **Lifecycle** → Metadata → Tags → Summaries → **Source metadata** → Collections.
- [ ] **Step 4: Run tests.** `npm test -- --testPathPattern='admin-editor'` → ALL pass.
- [ ] **Step 5: Lint + format + commit.**

```bash
npx eslint 'src/app/admin/documents/[id]/page.tsx' src/__tests__/admin-editor.test.tsx
npx prettier --write 'src/app/admin/documents/[id]/page.tsx' src/__tests__/admin-editor.test.tsx
git add 'src/app/admin/documents/[id]/page.tsx' src/__tests__/admin-editor.test.tsx
git commit -m "feat(admin): editor panel reorder — lifecycle first, source metadata after summaries"
```

---

### Task 4: Verification sweep

- [ ] **Step 1:** `npm test` → all suites pass (any `*.db.test.ts` flake under parallel workers → re-verify with `npm run test:db`, which is the serialized gate).
- [ ] **Step 2:** `npm run lint` → clean. Files-changed prettier check: `git diff --name-only <base>..HEAD | grep -v '.md$' | xargs npx prettier --check` → clean.
- [ ] **Step 3:** `npx next build --webpack` → green.
- [ ] **Step 4:** Manual smoke against the local stack (docker pg + `npm run dev`, login as local admin): select two queue docs → bulk Promote with confirm → summary notice; open a flagged doc → review bar shows position; Promote advances; Skip advances; last doc's Skip disabled.
- [ ] **Step 5:** Fix anything found; commit.
