# Feedback Layer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add visible, screen-reader-announced feedback (a shared Flash notice, loading lines, debounced search, and an unsaved-changes indicator) across the admin UI without introducing any new dependency.
**Architecture:** One small shared client component (`Flash`) replaces the inline `{notice && …}{error && …}` pairs on the eight admin pages; each list page gains a `loading` boolean gating its table; the catalog search input is split off the synchronous `updateFilter` path onto a 300 ms debounce; the editor grows a `dirty` state (mirroring the existing `formDirty` ref) that drives the Save-button label and a `beforeunload` guard.
**Tech Stack:** Next.js 16 App Router, React client components, Chakra `Box`/`Heading`/`Text`, inline styles, Jest + @testing-library/react (jsdom), fake timers.
**Spec:** docs/superpowers/specs/2026-07-09-feedback-layer-design.md

---

## Context for the implementer

**Repo rules (follow exactly):**
- **Arrow-function components only.** eslint `react/function-component-definition` is enforced — every component (incl. `Flash`) is `const Name = (props) => { … }`, never `function Name() {}`.
- **Styling:** inline `style={{…}}` objects + Chakra `Box`/`Heading`/`Text`. No new UI libs, no CSS modules, no toast library. Existing notice green is `#0A6640`, error red is `#C11101`.
- **Fetch:** app code uses `adminFetch` from `src/app/admin/lib/api`; `/api/admin/auth/me` uses raw `fetch`. Don't change this.
- **Commits:** run `npx prettier --write <files>` (or `npm run format`) before every commit; keep `npm run lint` clean. **NEVER add `Co-Authored-By` trailers.** One logical change per commit with the exact message given.
- **Targeted tests:** `npm test -- --testPathPattern='admin-flash'` (swap the pattern per task). Do not run the whole suite each step.

**Verified code facts (file:line at time of writing):**
- The eight pages and their inline notice/error blocks to replace:
  | Page | File | notice/error block lines | Flash import path |
  |---|---|---|---|
  | Documents (catalog) | `src/app/admin/documents/page.tsx` | 203–208 | `../components/Flash` |
  | Review queue | `src/app/admin/review/page.tsx` | 348–353 | `../components/Flash` |
  | Editor | `src/app/admin/documents/[id]/page.tsx` | 474–479 | `../../components/Flash` |
  | Upload | `src/app/admin/upload/page.tsx` | 159–164 | `../components/Flash` |
  | Import | `src/app/admin/import/page.tsx` | 293–298 | `../components/Flash` |
  | Tags | `src/app/admin/tags/page.tsx` | 172–177 | `../components/Flash` |
  | Collections | `src/app/admin/collections/page.tsx` | 100–101 | `../components/Flash` |
  | Users | `src/app/admin/users/page.tsx` | 107–108 | `../components/Flash` |
- Every page already holds `const [notice, setNotice] = useState<string | null>(null)` and `const [error, setError] = useState<string | null>(null)` with setters used throughout. Flash reuses that state verbatim — only the *rendering* moves. (Import has `notice`/`error`; Upload/Review/Editor/Tags/Collections/Users all have both.)
- **ReviewBar** (`src/app/admin/components/ReviewBar.tsx:80`) is `position:'sticky'; zIndex:10`. Flash MUST exceed that — use `zIndex:1000`. Flash is `position:'fixed'` bottom-right; the admin layout has no `transform`/`filter`/`perspective` ancestor, so fixed is viewport-anchored (confirmed).
- **Documents search is NOT a drop-in debounce.** Today the search `<input>` (page.tsx:298–308) calls `updateFilter('search', e.target.value)`; `updateFilter` (146–152) `setFilters` + `setPage(0)` + `setSelected(new Set())` + `load(next, 0)` — i.e. it loads **synchronously**, exactly like the status/language/year/collection/tag `<select>`s (216, 235, 249, 262, 275). The debounce must split *search only* onto a timer while the selects keep loading immediately. `load` is guarded by `reqSeq` (100, 103, 117, 122) for out-of-order **responses**, but that does NOT protect against a stale pending search timer firing with old **request params** after a select change — so the pending timer must be cleared whenever a select/pagination load fires. `load` currently has `try/catch` and **no `finally`**.
- **Editor dirty facts** (`src/app/admin/documents/[id]/page.tsx`): `formDirty` is a ref (179) — a ref alone cannot re-render, hence the new `dirty` **state**. `formDirty.current = true` is set at the three field `onChange`s (634, 656, 677). The **reset** happens in exactly one place — inside `load()`'s branch `if (opts.resetForm || !formDirty.current) { … formDirty.current = false }` (218–225). Both dirty-reset points funnel through here: (a) initial/`resetForm` load (241), and (b) **post-save** `await load({ resetForm: true })` in `saveMetadata` (272). Setting `setDirty(false)` inside that branch covers both. The metadata Save button is at 715–725 (`onClick={saveMetadata}`, label `Save`). Editor `load` is a `useCallback` (214) and its mount effect (239–252) also fires tag/collection/me fetches.
- **List-page `load` finally spots** (all are `useCallback` with `try/catch`, no `finally` — add `finally { setLoading(false) }`): documents 102–125, review 64–76, tags 42–50, collections 30–38, users 26–33.
- **Loading applies to the five list/table pages** (documents, review, tags, collections, users) — each renders a table gated on a mount fetch. Upload (form; best-effort health fetch, upload/page.tsx:47–51) and Import (no mount fetch) and the Editor (progressive detail-gated panels) get **Flash only, no loading line** — recorded here so nobody adds a spurious one.
- Test infra: component-test model = `src/__tests__/admin-status-chip.test.tsx`. Editor suite `src/__tests__/admin-editor.test.tsx` has `setupFetchMock` (83–143) + `next/navigation` mock (16–27). Review suite `src/__tests__/admin-review-page.test.tsx`. **No documents-page component test exists yet** — this plan creates one.

---

## Task 1 — `Flash` component + test

**Files:**
- Create: `src/app/admin/components/Flash.tsx`
- Test: `src/__tests__/admin-flash.test.tsx`

- [ ] **1.1 Write the failing test** `src/__tests__/admin-flash.test.tsx`:

```tsx
import { render, screen, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Flash } from '@/app/admin/components/Flash'

describe('Flash', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it('renders nothing when notice and error are both null', () => {
    const { container } = render(
      <Flash notice={null} error={null} onDismiss={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a notice inside an aria-live polite status region', () => {
    render(<Flash notice='Saved.' error={null} onDismiss={() => {}} />)
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByText('Saved.')).toBeInTheDocument()
  })

  it('auto-dismisses a notice after 6 seconds', () => {
    const onDismiss = jest.fn()
    render(<Flash notice='Saved.' error={null} onDismiss={onDismiss} />)
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => {
      jest.advanceTimersByTime(6000)
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does NOT auto-dismiss an error', () => {
    const onDismiss = jest.fn()
    render(<Flash notice={null} error='Boom.' onDismiss={onDismiss} />)
    act(() => {
      jest.advanceTimersByTime(6000)
    })
    expect(onDismiss).not.toHaveBeenCalled()
    expect(screen.getByText('Boom.')).toBeInTheDocument()
  })

  it('shows the error when both notice and error are set (error wins, no auto-dismiss)', () => {
    const onDismiss = jest.fn()
    render(<Flash notice='Saved.' error='Boom.' onDismiss={onDismiss} />)
    expect(screen.getByText('Boom.')).toBeInTheDocument()
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
    act(() => {
      jest.advanceTimersByTime(6000)
    })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('calls onDismiss when the close button is clicked', () => {
    const onDismiss = jest.fn()
    render(<Flash notice='Saved.' error={null} onDismiss={onDismiss} />)
    screen.getByRole('button', { name: /dismiss/i }).click()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **1.2 Run — expect failure** (module not found): `npm test -- --testPathPattern='admin-flash'`
- [ ] **1.3 Implement** `src/app/admin/components/Flash.tsx` (complete file):

```tsx
'use client'

import { useEffect, useRef } from 'react'
import { Box, Text } from '@chakra-ui/react'

const AUTO_DISMISS_MS = 6000

/**
 * Flash — shared feedback notice for the admin UI. Fixed bottom-right, above
 * the sticky ReviewBar (zIndex 10). role='status' + aria-live='polite'
 * announces changes to screen readers. Success notices auto-dismiss after 6 s;
 * errors persist until dismissed or replaced. Latest message wins — no queue.
 * Pages keep their own notice/error state; only rendering moves here.
 */
export const Flash = ({
  notice,
  error,
  onDismiss,
}: {
  notice: string | null
  error: string | null
  onDismiss: () => void
}) => {
  // Keep the latest onDismiss without re-arming the timer on every parent render.
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    // Only a standalone notice auto-dismisses; an error (which wins the display)
    // must persist.
    if (!notice || error) return
    const t = setTimeout(() => dismissRef.current(), AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [notice, error])

  if (!notice && !error) return null

  const isError = error != null
  const message = error ?? notice
  const fg = isError ? '#C11101' : '#0A6640'
  const bg = isError ? '#FDEDEC' : '#E6F4EA'

  return (
    <Box
      role='status'
      aria-live='polite'
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 1000,
        maxWidth: 360,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '10px 14px',
        borderRadius: 6,
        background: bg,
        border: `1px solid ${fg}`,
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      }}
    >
      <Text style={{ color: fg, flex: 1 }}>{message}</Text>
      <button
        type='button'
        onClick={onDismiss}
        aria-label='Dismiss'
        style={{
          color: fg,
          cursor: 'pointer',
          background: 'none',
          border: 'none',
          fontSize: 18,
          lineHeight: 1,
          padding: 0,
        }}
      >
        ×
      </button>
    </Box>
  )
}

export default Flash
```

- [ ] **1.4 Run — expect pass:** `npm test -- --testPathPattern='admin-flash'`
- [ ] **1.5 Lint + format:** `npm run lint` then `npx prettier --write src/app/admin/components/Flash.tsx src/__tests__/admin-flash.test.tsx`
- [ ] **1.6 Commit:** `git commit -m "feat(admin): shared Flash feedback component (fixed, aria-live, auto-dismiss)"`

---

## Task 2 — Adopt Flash + loading lines across the eight pages

Mechanical. For **every** page: add the import, then replace the inline notice/error block (see the table above) with the Flash element. `onDismiss` clears **both** setters. Ship in three commits.

### The Flash replacement (identical shape on every page)

Add near the other admin imports:
```tsx
import { Flash } from '<path from the table>'
```
Replace the page's `{notice && …}{error && …}` block with:
```tsx
<Flash
  notice={notice}
  error={error}
  onDismiss={() => {
    setNotice(null)
    setError(null)
  }}
/>
```
(Collections and Users have the block as two single-line expressions — replace both lines with the one Flash element.)

### The loading pattern (list pages only: documents, review, tags, collections, users)

1. Add state: `const [loading, setLoading] = useState(true)`.
2. Add `finally { setLoading(false) }` to the mount `load` useCallback's `try/catch` (see finally-spots in Context). Documents' `load` returns early on the `reqSeq` staleness check — `finally` still runs, so an unconditional `setLoading(false)` there is correct.
3. Gate the table so a single `<Text>Loading…</Text>` shows while loading and the empty-state shows only afterwards (per page below).

- [ ] **2.1 Documents + Review** (`documents/page.tsx`, `review/page.tsx`)
  - Documents: import Flash (`../components/Flash`); replace block 203–208. Add `loading` state + `finally { setLoading(false) }` in `load` (after the `catch`, 124). Change the table region (355) from `{items.length === 0 ? (…) : (<table>…)}` to:
    ```tsx
    {loading ? (
      <Text>Loading…</Text>
    ) : items.length === 0 ? (
      <Text>No documents found.</Text>
    ) : (
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        {/* …unchanged… */}
      </table>
    )}
    ```
  - Review: import Flash (`../components/Flash`); replace block 348–353. Add `loading` state + `finally { setLoading(false) }` in `load` (75). Change region 404 from `{items.length === 0 ? (queue-empty) : (<table…>)}` to a three-way `{loading ? <Text>Loading…</Text> : items.length === 0 ? (queue-empty) : (<table…>)}`.
  - **Failing test first** — extend `src/__tests__/admin-review-page.test.tsx` with:
    ```tsx
    it('shows a loading line before the queue resolves', () => {
      render(
        <ChakraProvider>
          <ReviewQueuePage />
        </ChakraProvider>,
      )
      expect(screen.getByText('Loading…')).toBeInTheDocument()
    })
    ```
    (Assert synchronously right after `render`, before any `await` — the fetch mock resolves on a microtask, so the first paint has `loading===true`.)
  - Run `npm test -- --testPathPattern='admin-review-page'` — expect the new test to fail, then pass after the edit. Lint + `npx prettier --write` the two pages + the test.
  - [ ] Commit: `git commit -m "feat(admin): Flash + loading line on catalog and review queue"`

- [ ] **2.2 Tags + Collections + Users** (`tags/page.tsx`, `collections/page.tsx`, `users/page.tsx`)
  - Each: import Flash (`../components/Flash`); replace its notice/error block; add `loading` state + `finally { setLoading(false) }` in its `load`.
  - Tags: at the empty/facets region (178 map + 300 empty), gate to:
    ```tsx
    {loading ? (
      <Text>Loading…</Text>
    ) : tags.length === 0 ? (
      <Text>No tags yet.</Text>
    ) : (
      distinctFacets.map((facet) => ( /* …unchanged… */ ))
    )}
    ```
    (Move the existing `{tags.length === 0 && <Text>No tags yet.</Text>}` at 300 into this ternary; remove the standalone line.)
  - Collections: replace the empty tbody row (163–167) `{items.length === 0 && (<tr>…No collections yet.…</tr>)}` with:
    ```tsx
    {loading ? (
      <tr>
        <td colSpan={5} style={cell}>Loading…</td>
      </tr>
    ) : items.length === 0 ? (
      <tr>
        <td colSpan={5} style={cell}>No collections yet.</td>
      </tr>
    ) : null}
    ```
  - Users: replace the empty tbody row (156–160) analogously with `colSpan={6}`, Loading… / `No users found.` / null.
  - No new test file required here (covered by the sweep in Task 5); keep existing suites green.
  - Lint + `npx prettier --write` the three pages.
  - [ ] Commit: `git commit -m "feat(admin): Flash + loading line on tags, collections, users"`

- [ ] **2.3 Editor + Upload + Import** (Flash only — no loading line)
  - Editor (`documents/[id]/page.tsx`): import Flash (`../../components/Flash`); replace block 474–479 with the Flash element. (Dirty/beforeunload come in Task 4.)
  - Upload (`upload/page.tsx`): import Flash (`../components/Flash`); replace block 159–164.
  - Import (`import/page.tsx`): import Flash (`../components/Flash`); replace block 293–298.
  - Lint + `npx prettier --write` the three pages. Confirm `npm test -- --testPathPattern='admin-editor|admin-import'` stays green.
  - [ ] Commit: `git commit -m "feat(admin): Flash on editor, upload, import"`

---

## Task 3 — Debounced catalog search

**Files:** Modify `src/app/admin/documents/page.tsx`; Create test `src/__tests__/admin-documents-page.test.tsx`.

Split search off the synchronous `updateFilter` path onto a 300 ms timer; selects/pagination stay immediate and must cancel any pending search timer.

- [ ] **3.1 Write the failing test** `src/__tests__/admin-documents-page.test.tsx`:

```tsx
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import CatalogPage from '@/app/admin/documents/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

jest.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => null }),
}))

const doc = {
  id: 'd1',
  externalId: 'ext-1',
  title: 'Doc One',
  language: 'en',
  status: 'searchable',
  yearPublished: 2024,
}

function setupFetchMock() {
  const fetchMock = jest.fn((url: string) => {
    if (url.startsWith('/api/admin/collections')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, collections: [] }),
      } as any)
    }
    if (url.startsWith('/api/admin/tags')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, tags: [] }),
      } as any)
    }
    // /api/admin/documents (list + years backfill)
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ items: [doc], total: 1 }),
    } as any)
  })
  global.fetch = fetchMock as any
  return fetchMock
}

describe('CatalogPage', () => {
  afterEach(() => jest.useRealTimers())

  it('shows a loading line before documents resolve', () => {
    setupFetchMock()
    render(
      <ChakraProvider>
        <CatalogPage />
      </ChakraProvider>,
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('debounces rapid search keystrokes into a single request', async () => {
    const fetchMock = setupFetchMock()
    render(
      <ChakraProvider>
        <CatalogPage />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Doc One')).toBeInTheDocument())

    jest.useFakeTimers()
    const input = screen.getByPlaceholderText(/Search title/i)
    const countSearchCalls = () =>
      fetchMock.mock.calls.filter(([u]) =>
        String(u).includes('search=cli'),
      ).length

    fireEvent.change(input, { target: { value: 'c' } })
    fireEvent.change(input, { target: { value: 'cl' } })
    fireEvent.change(input, { target: { value: 'cli' } })
    // Within the debounce window: no request fired yet.
    expect(countSearchCalls()).toBe(0)

    act(() => {
      jest.advanceTimersByTime(300)
    })
    expect(countSearchCalls()).toBe(1)
  })
})
```

- [ ] **3.2 Run — expect failure** (`Loading…` not gated yet from Task 2? it is — but the debounce test fails because search still loads per keystroke): `npm test -- --testPathPattern='admin-documents-page'`
- [ ] **3.3 Implement** in `src/app/admin/documents/page.tsx`:
  - Add a timer ref beside `reqSeq` (near 100): `const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)`.
  - Add a helper to cancel a pending search timer, and call it from the immediate paths:
    ```tsx
    const clearSearchDebounce = () => {
      if (searchDebounce.current) {
        clearTimeout(searchDebounce.current)
        searchDebounce.current = null
      }
    }
    ```
  - In `updateFilter` (146) — used by the selects — call `clearSearchDebounce()` first (so a stale pending search timer can't overwrite the just-loaded select filters):
    ```tsx
    const updateFilter = (key: keyof typeof filters, value: string) => {
      clearSearchDebounce()
      const next = { ...filters, [key]: value }
      setFilters(next)
      setPage(0)
      setSelected(new Set())
      load(next, 0)
    }
    ```
  - In `goToPage` (154) add `clearSearchDebounce()` as the first line.
  - Add the debounced search handler:
    ```tsx
    const updateSearch = (value: string) => {
      const next = { ...filters, search: value }
      setFilters(next) // reflect keystrokes immediately in the input
      setPage(0)
      setSelected(new Set())
      clearSearchDebounce()
      searchDebounce.current = setTimeout(() => load(next, 0), 300)
    }
    ```
  - Cancel the timer on unmount (add near the mount effect):
    ```tsx
    useEffect(() => () => clearSearchDebounce(), [])
    ```
  - Change the search `<input>` (302) `onChange` from `updateFilter('search', e.target.value)` to `updateSearch(e.target.value)`. Leave all `<select>`s on `updateFilter` (immediate).
- [ ] **3.4 Run — expect pass:** `npm test -- --testPathPattern='admin-documents-page'`
- [ ] **3.5 Lint + format:** `npm run lint`; `npx prettier --write src/app/admin/documents/page.tsx src/__tests__/admin-documents-page.test.tsx`
- [ ] **3.6 Commit:** `git commit -m "feat(admin): debounce catalog search, keep selects immediate"`

---

## Task 4 — Editor unsaved-changes indicator + beforeunload

**Files:** Modify `src/app/admin/documents/[id]/page.tsx`; Test `src/__tests__/admin-editor.test.tsx`.

The `formDirty` ref can't re-render, so add a `dirty` state mirroring it. Reset happens only inside `load()`'s reset branch, which is reached by both the initial/`resetForm` load and the post-save `load({ resetForm: true })`. App Router exposes no route-change hook — in-app navigation is intentionally NOT intercepted (accepted limitation per spec); only tab close/refresh is guarded via `beforeunload`.

- [ ] **4.1 Write the failing tests** — add to `src/__tests__/admin-editor.test.tsx`:

```tsx
it('marks the Save button dirty after an edit and clears it after save', async () => {
  render(
    <ChakraProvider>
      <DocumentEditorPage />
    </ChakraProvider>,
  )
  await waitFor(() => expect(screen.getByText('Authors')).toBeInTheDocument())

  // Save starts clean.
  expect(
    screen.getByRole('button', { name: 'Save' }),
  ).toBeInTheDocument()

  // Edit the URL field → dirty.
  const url = screen.getByDisplayValue('https://example.com/test')
  fireEvent.change(url, { target: { value: 'https://example.com/edited' } })
  expect(
    screen.getByRole('button', { name: 'Save (unsaved changes)' }),
  ).toBeInTheDocument()

  // Save → load({resetForm:true}) clears dirty.
  fireEvent.click(screen.getByRole('button', { name: 'Save (unsaved changes)' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument(),
  )
})

it('registers a beforeunload handler only while dirty', async () => {
  const addSpy = jest.spyOn(window, 'addEventListener')
  render(
    <ChakraProvider>
      <DocumentEditorPage />
    </ChakraProvider>,
  )
  await waitFor(() => expect(screen.getByText('Authors')).toBeInTheDocument())

  expect(
    addSpy.mock.calls.some(([e]) => e === 'beforeunload'),
  ).toBe(false)

  fireEvent.change(screen.getByDisplayValue('https://example.com/test'), {
    target: { value: 'https://example.com/edited' },
  })
  expect(
    addSpy.mock.calls.some(([e]) => e === 'beforeunload'),
  ).toBe(true)
  addSpy.mockRestore()
})
```

- [ ] **4.2 Run — expect failure:** `npm test -- --testPathPattern='admin-editor'`
- [ ] **4.3 Implement** in `src/app/admin/documents/[id]/page.tsx`:
  - Add state beside `formDirty` (179): `const [dirty, setDirty] = useState(false)`.
  - At each of the three field `onChange`s (634, 656, 677), add `setDirty(true)` next to `formDirty.current = true`:
    ```tsx
    onChange={(e) => {
      formDirty.current = true
      setDirty(true)
      setForm((f) => ({ ...f, [key]: e.target.value }))
    }}
    ```
  - Inside `load()`'s reset branch (218–225), add `setDirty(false)` after `formDirty.current = false` — this is the single reset point covering initial load, `resetForm`, and post-save:
    ```tsx
    if (opts.resetForm || !formDirty.current) {
      setForm(
        Object.fromEntries(
          EDITABLE.map(({ key }) => [key, body.document[key] ?? '']),
        ),
      )
      formDirty.current = false
      setDirty(false)
    }
    ```
  - Register `beforeunload` only while dirty (add near the mount effect, ~252):
    ```tsx
    useEffect(() => {
      if (!dirty) return
      const handler = (e: BeforeUnloadEvent) => {
        e.preventDefault()
        e.returnValue = ''
      }
      window.addEventListener('beforeunload', handler)
      return () => window.removeEventListener('beforeunload', handler)
    }, [dirty])
    ```
  - Change the metadata Save button label (724) from `Save` to `{dirty ? 'Save (unsaved changes)' : 'Save'}`.
- [ ] **4.4 Run — expect pass:** `npm test -- --testPathPattern='admin-editor'`
- [ ] **4.5 Lint + format:** `npm run lint`; `npx prettier --write src/app/admin/documents/[id]/page.tsx src/__tests__/admin-editor.test.tsx`
- [ ] **4.6 Commit:** `git commit -m "feat(admin): editor unsaved-changes indicator + beforeunload guard"`

---

## Task 5 — Verification sweep

**Files:** none (or tiny fixups).

- [ ] **5.1** Full targeted admin suite green: `npm test -- --testPathPattern='admin-'`
- [ ] **5.2** Lint + format clean repo-wide: `npm run lint` then `npm run format:check`
- [ ] **5.3** Grep for stragglers — no admin page should still render the old inline banner:
  `git grep -n "color: '#0A6640'" src/app/admin` and `git grep -n "color: '#C11101'" src/app/admin` should now only match `Flash.tsx` (and any intentionally-kept ReviewBar/import-row coloring, e.g. import/page.tsx's `error:'#C11101'` decision map at 213 and ReviewBar's `#feb2b2` — those are NOT notice banners, leave them).
- [ ] **5.4** Confirm every list page shows `Loading…` on mount and each mutation surfaces a Flash (spot-check by reading the diff, or run the app per `docs/runbooks/local-testing.md`).
- [ ] **5.5** If everything passes, no commit needed (work already committed per task). Otherwise commit fixups with a `fix(admin): …` message.

---

### DRY / YAGNI notes
- Flash is the single source of feedback rendering — do not reintroduce inline `{notice && …}` anywhere.
- No toast queue, no context/provider, no route-change interception, no per-panel spinners, no optimistic updates, no public-app changes (spec non-goals).
- Loading = one `<Text>Loading…</Text>` line, five list pages only. Do not add loading lines to editor/upload/import.
