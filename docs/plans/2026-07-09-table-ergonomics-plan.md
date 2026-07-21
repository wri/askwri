# Table Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Follow TDD: write the failing test, watch it fail, implement, watch it pass, commit.

**Goal:** Make the document catalog sortable (Title / Year / Status) and make its entire view state — filters, sort, and page — live in the URL, so a filtered/sorted view survives refresh, back/forward, and can be shared by copying the link.

**Architecture:** Two layers change, no schema and no new endpoints. (1) The list query `listAdminDocuments` (`src/db/queries/documentsAdmin.ts`) and its route (`src/app/api/admin/documents/route.ts`) gain a whitelisted `sort`/`dir` pass-through appended to the existing `ORDER BY` (always keeping the `d.id DESC` tiebreaker; default unchanged: `created_at DESC`). (2) The catalog page (`src/app/admin/documents/page.tsx`) is refactored to **URL-as-source-of-truth**: every state change writes to the URL via `router.replace`, and a single effect keyed on `useSearchParams` derives filters/sort/page from the URL and calls `load()`. The old imperative `updateFilter → load` path is removed so there is exactly one data-fetch trigger (no hybrid double-fetch).

**Tech Stack:** Next.js 16 App Router client components, TypeORM raw SQL query, existing `adminFetch` helper, Jest (jsdom for the component test, node for the DB/query test).

**Spec:** `docs/superpowers/specs/2026-07-09-table-ergonomics-design.md`

---

## ⚠️ SEQUENCING — read before starting

**This plan executes AFTER the feedback-layer plan.** Both plans rework `src/app/admin/documents/page.tsx`. The feedback-layer slice introduces the **debounced search input** (local input state + a settled/debounced value). This plan does **not** create the debounce — it integrates with it:

- The search box keeps its feedback-layer-owned local state for what the user is typing.
- When the debounce settles, its committed value must be written to the **URL** (via `updateFilter('search', value)` / `setQuery`), not fetched imperatively.
- **Round-trip both ways:** the local input state must also be seeded FROM the URL (`searchParams.get('search')`) on mount and on external URL changes — see the "Search input" note in Task 2 Step 2b. A shared `?search=foo` link must show "foo" in the box, not an empty input over filtered results.
- Do **not** add a second debounce, and do **not** revert the feedback-layer's input handling. If you are executing this plan and the debounce is not yet present, stop and confirm the feedback-layer plan landed first.

Rebase/verify against the current `page.tsx` before writing Task 2 code — line numbers below are from the pre-feedback-layer file and will have shifted.

---

## Context for the implementer (read first)

**Repo rules (executors do NOT inherit CLAUDE.md — restated here):**
- React components are **arrow functions** (eslint `react/function-component-definition`). `CatalogInner`/`CatalogPage` are already arrows — keep them so.
- Admin UI style: plain inline styles + Chakra `Box/Heading/Text`; data access via `adminFetch` from `src/app/admin/lib/api.ts` (it wraps `fetch`, throws `Error(body.error || 'HTTP <status>')` on failure, self-redirects on 401).
- `npx prettier --write <touched files>` before every commit; keep `npm run lint` clean.
- **Never add Co-Authored-By trailers to commits.**
- Targeted tests: `npm test -- --testPathPattern='<name>'`.

**Verified code facts (file:line):**
- `listAdminDocuments` builds a `where: string[]` + `params: any[]` with a `p(v)` helper that pushes a param and returns `$n` (`documentsAdmin.ts:59-64`). The items query's `ORDER BY d.created_at DESC, d.id DESC` is at `documentsAdmin.ts:92`; `LIMIT/OFFSET` params are appended AFTER the filter params (`documentsAdmin.ts:84-95`). The count query reuses only the filter `params` (`:97-100`). **Sort must be interpolated from a whitelist constant only — never from a bound param — so the column/direction cannot inject.**
- The route (`route.ts`) validates UUID params and returns `NextResponse.json({ ok: false, error }, { status: 400 })` on bad input (`route.ts:17-22`); it reads filters from `req.nextUrl.searchParams` (`:14-36`) and clamps `limit`/`offset` (`:24-27`). There is **no** `badRequest` helper — copy the inline 400 pattern.
- `route.ts` currently passes `(filters, paginationArg)`; add a third `sort` arg.
- The page (`page.tsx`) imports `useSearchParams` only — **`useRouter` and `usePathname` are NOT imported yet** (`page.tsx:5`). Add them.
- `filters` is `useState` (`page.tsx:48-55`), read once from `initialCollectionId = searchParams.get('collectionId')` (`:40`). `updateFilter` (`:146-152`) mutates state then imperatively calls `load(next, 0)`. The mount effect (`:127-144`) resets filters from `initialCollectionId` and calls `load(f, 0)`. `goToPage` (`:154-158`) calls `load(filters, pageNum)`. **All three imperative `load()` call sites are what this refactor removes** — replace with URL writes + one effect.
- `load` (`:102-125`) has a `reqSeq` stale-response guard (`:100`, `:103`, `:117`, `:122`) — **preserve it**.
- `selected` (`Set<string>`), `bulkCollectionId`, `notice`, `error` are transient UI state (`:56-59`) — they stay `useState`, are NOT URL state, and are cleared on navigation (as today).
- Table header renders `['External ID','Title','Language','Status','Year']` via `.map` (`page.tsx:368-381`); rows render External ID / Title(link) / Language / Status(`StatusChip`) / Year (`:394-407`). There is **no `created_at` column** — `created_at` is the default/reset order, NOT a clickable header.
- `PAGE_SIZE = 50` (`:31`). `Suspense` wraps `CatalogInner` (`:457-461`) — required because `useSearchParams` suspends; keep it.
- Component-test model: `src/__tests__/admin-review-page.test.tsx` — mocks `next/navigation` (`useRouter.replace`, `useSearchParams`), mocks `global.fetch` keyed by URL (that is what `adminFetch` calls), renders inside `ChakraProvider`, asserts via `screen`/`waitFor`/`fireEvent`. No documents-page component test exists yet — create `admin-documents-page.test.tsx`.
- DB/query-test model: `src/__tests__/admin-documents.db.test.ts` — node env, gated on `process.env.DATABASE_URL` (`const d = hasDb ? describe : describe.skip`), inserts docs with raw SQL and cleans up in `finally`/`afterAll`. The F2 suite (`:510-598`) is the closest sibling for a new sort suite.

**Sort whitelist (authoritative):** `{ title, year_published, status, created_at } × { asc, desc }`. Header buttons expose only Title→`title`, Status→`status`, Year→`year_published`. `created_at` is reachable only as the default (no sort param).

**Out of scope (spec non-goals):** no multi-column sort, no saved views, no column chooser, no review-queue sorting, no pagination redesign (Prev/Next stays), no index changes (500-row scale).

---

### Task 1: Whitelisted server-side sort (query fn + route)

**Files:**
- Modify: `src/db/queries/documentsAdmin.ts`
- Modify: `src/app/api/admin/documents/route.ts`
- Test: `src/__tests__/admin-documents.db.test.ts` (add a sort suite + pure validator tests)

#### Step 1 — Write the failing tests first

Add to `src/__tests__/admin-documents.db.test.ts`. `listAdminDocuments` is **already imported** there (line 8) — only add `validateSort` to the existing import list:

```ts
import {
  // …existing (listAdminDocuments already at :8)…
  validateSort,
} from '@/db/queries/documentsAdmin'
```

Pure validator tests (NOT gated on DB — plain `describe`, put near the top of the file):

```ts
describe('validateSort (whitelist)', () => {
  it('accepts whitelisted sort keys and directions', () => {
    expect(validateSort('title', 'asc')).toBe(true)
    expect(validateSort('year_published', 'desc')).toBe(true)
    expect(validateSort('status', 'asc')).toBe(true)
    expect(validateSort('created_at', 'desc')).toBe(true)
    expect(validateSort(undefined, undefined)).toBe(true) // default
    expect(validateSort('title', undefined)).toBe(true)
  })
  it('rejects unknown columns or directions (would 400 at the route)', () => {
    expect(validateSort('id', 'asc')).toBe(false)
    expect(validateSort('title; drop table', 'asc')).toBe(false)
    expect(validateSort('title', 'sideways')).toBe(false)
    expect(validateSort('title', 'ASC')).toBe(false) // lowercase only
  })
  it('rejects Object.prototype key names (prototype-chain bypass)', () => {
    // `sort in SORT_COLUMNS` would pass these (inherited props) and then
    // interpolate a native-function string into ORDER BY → SQL error → 500.
    // Object.hasOwn must reject them so the route 400s instead.
    expect(validateSort('constructor', 'asc')).toBe(false)
    expect(validateSort('toString', 'asc')).toBe(false)
    expect(validateSort('__proto__', 'asc')).toBe(false)
    expect(validateSort('hasOwnProperty', 'desc')).toBe(false)
  })
})
```

Route-level 400 test (also NOT DB-gated — `validateSort` runs BEFORE `initializeDatabase`, so this exercises the route without a database; auth via the `ADMIN_API_TOKEN` bearer path in `requireIdentity`):

```ts
describe('GET /api/admin/documents sort validation (route, no DB)', () => {
  const savedToken = process.env.ADMIN_API_TOKEN
  beforeAll(() => {
    process.env.ADMIN_API_TOKEN = 'sort-test-token'
  })
  afterAll(() => {
    if (savedToken === undefined) delete process.env.ADMIN_API_TOKEN
    else process.env.ADMIN_API_TOKEN = savedToken
  })

  const get = async (qs: string) => {
    const { NextRequest } = await import('next/server')
    const { GET } = await import('@/app/api/admin/documents/route')
    const req = new NextRequest(`http://localhost/api/admin/documents?${qs}`, {
      headers: { authorization: 'Bearer sort-test-token' },
    })
    return GET(req)
  }

  it('returns 400 (never 500) for a prototype-chain sort key', async () => {
    const res = await get('sort=toString&dir=asc')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  it('returns 400 for an unknown dir', async () => {
    const res = await get('sort=title&dir=sideways')
    expect(res.status).toBe(400)
  })
})
```

DB sort suite (gated — uses the existing `d = hasDb ? describe : describe.skip`):

```ts
d('listAdminDocuments sort (DB integration)', () => {
  const marker = `sorttest_${Date.now()}` // unique title token to isolate our rows
  const ids: string[] = []

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    // Three docs, out-of-order years, distinct so ordering is deterministic.
    for (const [ext, year] of [
      [`${marker}_a`, 2021],
      [`${marker}_b`, 2019],
      [`${marker}_c`, 2020],
    ] as const) {
      const [row] = await AppDataSource.query(
        `INSERT INTO documents (external_id, s3_key, title, status, year_published)
         VALUES ($1, $2, $3, 'searchable', $4) RETURNING id`,
        [ext, `documents/${ext}.pdf`, `${marker} title`, year],
      )
      ids.push(row.id)
    }
  })

  afterAll(async () => {
    for (const id of ids)
      await AppDataSource.query(`DELETE FROM documents WHERE id=$1`, [id])
    await AppDataSource.destroy()
  })

  const yearsFor = async (sort?: string, dir?: string) => {
    const { items } = await listAdminDocuments({ search: marker }, {}, { sort, dir })
    return items.map((i: any) => i.yearPublished)
  }

  it('sorts by year_published ascending', async () => {
    expect(await yearsFor('year_published', 'asc')).toEqual([2019, 2020, 2021])
  })

  it('sorts by year_published descending', async () => {
    expect(await yearsFor('year_published', 'desc')).toEqual([2021, 2020, 2019])
  })

  it('falls back to the default order for an unknown sort (no injection, no throw)', async () => {
    // Unknown key is ignored → default created_at DESC, id DESC tiebreaker.
    const items = await yearsFor('nonsense', 'asc')
    expect(items).toHaveLength(3) // returned rows, did not throw or inject
  })
})
```

Run and confirm they fail (module has no `validateSort`, `listAdminDocuments` ignores the 3rd arg):

```
npm test -- --testPathPattern='admin-documents.db'
```

#### Step 2 — Implement in `documentsAdmin.ts`

Add near the top (after the `AdminDocumentFilters` interface):

```ts
// Whitelisted sort columns. Values are interpolated directly into ORDER BY, so
// this map is the ONLY source of column SQL — never a bound param (no injection).
const SORT_COLUMNS = {
  title: 'd.title',
  year_published: 'd.year_published',
  status: 'd.status',
  created_at: 'd.created_at',
} as const
export type SortKey = keyof typeof SORT_COLUMNS

export interface SortOptions {
  sort?: string
  dir?: string
}

/** True when sort/dir are absent or both in the whitelist. Route uses it for the 400. */
export function validateSort(sort?: string, dir?: string): boolean {
  // Object.hasOwn, NOT `sort in SORT_COLUMNS`: `in` traverses the prototype
  // chain, so ?sort=constructor / toString / __proto__ would validate, then the
  // lookup would interpolate a native-function string into ORDER BY → SQL
  // error → 500 instead of the promised 400.
  if (sort != null && !Object.hasOwn(SORT_COLUMNS, sort)) return false
  if (dir != null && dir !== 'asc' && dir !== 'desc') return false
  return true
}
```

Change the signature to accept a third arg and build the `ORDER BY` from the whitelist:

```ts
export async function listAdminDocuments(
  filters: AdminDocumentFilters,
  pagination: PaginationOptions = {},
  sort: SortOptions = {},
): Promise<AdminDocumentListResult> {
```

Replace the hardcoded `ORDER BY` at `documentsAdmin.ts:92`. Before the items query, derive the clause safely (unknown/absent → default):

```ts
  // Object.hasOwn guard here too (defense in depth): a bare bracket lookup
  // would resolve prototype keys like 'constructor' to a function, not undefined.
  const sortColumn =
    sort.sort && Object.hasOwn(SORT_COLUMNS, sort.sort)
      ? SORT_COLUMNS[sort.sort as SortKey]
      : 'd.created_at'
  const sortDir = sort.dir === 'asc' ? 'ASC' : 'DESC'
  // d.id DESC stays as the deterministic tiebreaker (unchanged default: created_at DESC).
```

and in the items SQL:

```ts
     ORDER BY ${sortColumn} ${sortDir}, d.id DESC
```

The count query is unaffected (order-independent). Do not touch its params.

#### Step 3 — Implement in `route.ts`

After the UUID validations (and before `initializeDatabase`), read + validate sort, then pass it through:

```ts
    const sort = sp.get('sort') || undefined
    const dir = sp.get('dir') || undefined
    if (!validateSort(sort, dir)) {
      return NextResponse.json(
        { ok: false, error: 'invalid sort or dir' },
        { status: 400 },
      )
    }
```

Update the import and the call:

```ts
import { listAdminDocuments, validateSort } from '../../../../db/queries/documentsAdmin'
```

```ts
    const { items, total } = await listAdminDocuments(
      { /* …existing filters… */ },
      limit != null || offset != null ? { limit, offset } : {},
      { sort, dir },
    )
```

#### Step 4 — Verify + commit

```
npm test -- --testPathPattern='admin-documents.db'
npm run lint
npx prettier --write src/db/queries/documentsAdmin.ts src/app/api/admin/documents/route.ts src/__tests__/admin-documents.db.test.ts
```

Commit:

```
git add src/db/queries/documentsAdmin.ts src/app/api/admin/documents/route.ts src/__tests__/admin-documents.db.test.ts
git commit -m "feat(admin): whitelisted server-side sort for the document catalog"
```

---

### Task 2: URL-as-source-of-truth + sortable headers

**Files:**
- Modify: `src/app/admin/documents/page.tsx`
- Test: `src/__tests__/admin-documents-page.test.tsx` (create)

> Re-read the SEQUENCING note. Confirm the feedback-layer debounce is present and route its settled value through the URL writer below — do not add a new debounce.

#### Step 1 — Write the failing component tests first

Create `src/__tests__/admin-documents-page.test.tsx`, modeled on `admin-review-page.test.tsx`. The `next/navigation` mock must let each test (a) supply the current searchParams and (b) assert `router.replace` calls:

```tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import CatalogPage from '@/app/admin/documents/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

let mockParams = new URLSearchParams('')
const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockParams,
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  usePathname: () => '/admin/documents',
}))

const docs = [
  { id: 'd1', externalId: 'ext-1', title: 'Alpha', language: 'en', status: 'searchable', yearPublished: 2021 },
  { id: 'd2', externalId: 'ext-2', title: 'Beta', language: 'es', status: 'needs_review', yearPublished: 2020 },
]

// Capture every documents-list URL adminFetch requests so we can assert the query string.
let listUrls: string[] = []
const setupFetch = () => {
  listUrls = []
  global.fetch = jest.fn((url: string) => {
    if (url.startsWith('/api/admin/documents')) {
      if (!url.includes('limit=500')) listUrls.push(url) // ignore the loadYears() sweep
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, items: docs, total: 2 }) })
    }
    if (url.startsWith('/api/admin/collections'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, collections: [] }) })
    if (url.startsWith('/api/admin/tags'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, tags: [] }) })
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
  }) as any
}

const renderPage = () => render(<ChakraProvider><CatalogPage /></ChakraProvider>)

beforeEach(() => {
  mockParams = new URLSearchParams('')
  mockReplace.mockClear()
  setupFetch()
})

describe('CatalogPage — URL-driven view state (jsdom)', () => {
  it('applies filters from the URL to the list request', async () => {
    mockParams = new URLSearchParams('status=searchable&language=es')
    renderPage()
    await screen.findByText('Alpha')
    const listCall = listUrls.find((u) => u.includes('status=searchable'))
    expect(listCall).toBeDefined()
    expect(listCall).toContain('language=es')
  })

  it('applies sort + dir from the URL and marks the active header with aria-sort', async () => {
    mockParams = new URLSearchParams('sort=year_published&dir=asc')
    renderPage()
    await screen.findByText('Alpha')
    expect(listUrls.some((u) => u.includes('sort=year_published') && u.includes('dir=asc'))).toBe(true)
    const yearHeader = screen.getByRole('columnheader', { name: /Year/ })
    expect(yearHeader).toHaveAttribute('aria-sort', 'ascending')
  })

  it('writes a filter change to the URL via router.replace (not push), resetting page', async () => {
    renderPage()
    await screen.findByText('Alpha')
    // The filter selects have NO accessible name (no label/aria-label), so
    // getByRole('combobox', { name }) will not match — select by displayed option.
    fireEvent.change(screen.getByDisplayValue('All statuses'), {
      target: { value: 'needs_review' },
    })
    await waitFor(() => expect(mockReplace).toHaveBeenCalled())
    const target = mockReplace.mock.calls.at(-1)![0] as string
    expect(target).toContain('status=needs_review')
    expect(target).not.toContain('page=') // reset to default page 0 (omitted)
  })

  it('cycles a sortable header asc → desc → default through the URL', async () => {
    // The mocked useSearchParams reads module-level mockParams at render time,
    // so after each reassignment we MUST rerender — otherwise the click handler
    // sees stale params and the asc→desc→default assertions fail even against
    // correct code.
    const { rerender } = renderPage()
    const rerenderPage = () =>
      rerender(
        <ChakraProvider>
          <CatalogPage />
        </ChakraProvider>,
      )
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByRole('button', { name: /^Title/ })) // 1st click → asc
    expect(mockReplace.mock.calls.at(-1)![0]).toMatch(/sort=title.*dir=asc|dir=asc.*sort=title/)

    mockParams = new URLSearchParams('sort=title&dir=asc') // simulate URL settled
    rerenderPage()
    // Re-query after rerender; label now includes the ▲ glyph, /^Title/ still matches.
    fireEvent.click(screen.getByRole('button', { name: /^Title/ })) // 2nd click → desc
    expect(mockReplace.mock.calls.at(-1)![0]).toContain('dir=desc')

    mockParams = new URLSearchParams('sort=title&dir=desc')
    rerenderPage()
    fireEvent.click(screen.getByRole('button', { name: /^Title/ })) // 3rd click → default (no sort/dir)
    const cleared = mockReplace.mock.calls.at(-1)![0] as string
    expect(cleared).not.toContain('sort=')
    expect(cleared).not.toContain('dir=')
  })

  it('preserves an inbound ?collectionId= deep link in the list request', async () => {
    mockParams = new URLSearchParams('collectionId=abc-123')
    renderPage()
    await screen.findByText('Alpha')
    expect(listUrls.some((u) => u.includes('collectionId=abc-123'))).toBe(true)
  })
})
```

> Selector note: `getByDisplayValue('All statuses')` is the PRIMARY selector for the status `<select>` — the filter selects have no accessible names, so `getByRole('combobox', { name })` won't match (only add `aria-label`s if the feedback-layer plan already did). Adjust the header button name matcher to whatever label text (with the ▲/▼ glyph) the implementation renders.

Run and confirm failures:

```
npm test -- --testPathPattern='admin-documents-page'
```

#### Step 2 — Refactor `page.tsx` to URL-as-source-of-truth

**2a. Imports.** Add `useRouter`, `usePathname`:

```tsx
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
```

**2b. Derive view state from the URL (delete the `filters`/`page` `useState`).** Inside `CatalogInner`:

```tsx
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  // The URL is the single source of truth for the view. Everything below is derived.
  const filters = {
    status: searchParams.get('status') ?? '',
    language: searchParams.get('language') ?? '',
    collectionId: searchParams.get('collectionId') ?? '',
    search: searchParams.get('search') ?? '',
    yearPublished: searchParams.get('yearPublished') ?? '',
    tagId: searchParams.get('tagId') ?? '',
  }
  const sort = searchParams.get('sort') ?? ''
  const dir = (searchParams.get('dir') as 'asc' | 'desc' | '') ?? ''
  const page = Math.max(0, parseInt(searchParams.get('page') ?? '0', 10) || 0)
```

Keep `selected`, `bulkCollectionId`, `notice`, `error`, and the loaded-options state (`collections`, `tags`, `availableYears`, `items`, `total`) as `useState`.

> **Search input (feedback-layer seam — two directions, both required):** its live text stays feedback-layer-owned local state (that is what the `<input value=…>` binds to); `filters.search` above is the *committed* value from the URL used to build the request. Do not bind the input directly to `filters.search`. **But the local state must also be SEEDED from the URL**: initialize it from `searchParams.get('search') ?? ''` on mount, and re-sync it when the URL's `search` changes underneath it (e.g. back/forward) — otherwise a shared `?search=foo` link fetches filtered results while showing an EMPTY search box. Concretely: `useState(searchParams.get('search') ?? '')` plus a small effect that overwrites the local text when `filters.search` changes and the user isn't mid-typing (skip the sync while a debounce is pending, so it never clobbers keystrokes).

**2c. One URL writer.** Replace `updateFilter` (and its imperative `load`) with a writer that only mutates the URL. Navigation clears transient selection:

```tsx
  const setQuery = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString())
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v)
        else next.delete(k)
      }
      setSelected(new Set())
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [searchParams, pathname, router],
  )

  // Changing any filter resets to page 0 (omit the param).
  const updateFilter = (key: keyof typeof filters, value: string) =>
    setQuery({ [key]: value, page: '' })
```

**2d. Sort header cycle** (asc → desc → default), also page-reset:

```tsx
  const toggleSort = (key: string) => {
    if (sort !== key) setQuery({ sort: key, dir: 'asc', page: '' })
    else if (dir === 'asc') setQuery({ sort: key, dir: 'desc', page: '' })
    else setQuery({ sort: '', dir: '', page: '' }) // third click → default order
  }
```

**2e. Pagination** writes `page` (omit when 0):

```tsx
  const goToPage = (pageNum: number) =>
    setQuery({ page: pageNum <= 0 ? '' : String(pageNum) })
```

**2f. Extend `load` to carry sort** (keep the `reqSeq` guard exactly):

```tsx
  const load = useCallback(
    async (f: typeof filters, s: string, d: string, pageNum: number) => {
      const seq = ++reqSeq.current
      try {
        const params = new URLSearchParams()
        if (f.status) params.set('status', f.status)
        if (f.language) params.set('language', f.language)
        if (f.collectionId) params.set('collectionId', f.collectionId)
        if (f.search) params.set('search', f.search)
        if (f.yearPublished) params.set('yearPublished', f.yearPublished)
        if (f.tagId) params.set('tagId', f.tagId)
        if (s) params.set('sort', s)
        if (d) params.set('dir', d)
        params.set('limit', String(PAGE_SIZE))
        params.set('offset', String(pageNum * PAGE_SIZE))
        const body = await adminFetch<{ items: DocItem[]; total: number }>(
          `/api/admin/documents?${params}`,
        )
        if (seq !== reqSeq.current) return
        setItems(body.items)
        setTotal(body.total)
        setError(null)
      } catch (err: any) {
        if (seq !== reqSeq.current) return
        setError(err.message)
      }
    },
    [],
  )
```

**2g. Replace the mount effect with two effects** — one one-time loader for the dropdown options, and one URL-keyed loader for the list. This is the crux: there is now exactly ONE list-fetch trigger.

```tsx
  // Load dropdown options once.
  useEffect(() => {
    loadCollections()
    loadTags()
    loadYears()
  }, [loadCollections, loadTags, loadYears])

  // Single source of truth: whenever the URL query changes, reload the list.
  // Derives filters/sort/dir/page from searchParams above; no imperative load()
  // calls live anywhere else.
  useEffect(() => {
    load(filters, sort, dir, page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, load])
```

> Remove the old `initialCollectionId` variable and the old combined mount effect. The deep link works for free because `collectionId` is read from the URL like any other filter.

**2h. Sortable headers with `aria-sort`.** Replace the header `.map` (`page.tsx:368-381`) with an explicit column config; only Title/Status/Year are buttons:

```tsx
  const COLUMNS: { label: string; sortKey: string | null }[] = [
    { label: 'External ID', sortKey: null },
    { label: 'Title', sortKey: 'title' },
    { label: 'Language', sortKey: null },
    { label: 'Status', sortKey: 'status' },
    { label: 'Year', sortKey: 'year_published' },
  ]
```

```tsx
              {COLUMNS.map(({ label, sortKey }) => {
                const active = sortKey && sort === sortKey
                const ariaSort = !active
                  ? undefined
                  : dir === 'asc'
                    ? 'ascending'
                    : 'descending'
                return (
                  <th
                    key={label}
                    aria-sort={ariaSort}
                    style={{ ...cell, textAlign: 'left', background: '#f7f7f7' }}
                  >
                    {sortKey ? (
                      <button
                        onClick={() => toggleSort(sortKey)}
                        style={{
                          font: 'inherit',
                          fontWeight: 'inherit',
                          cursor: 'pointer',
                          background: 'none',
                          border: 'none',
                          padding: 0,
                        }}
                      >
                        {label}
                        {active ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </button>
                    ) : (
                      label
                    )}
                  </th>
                )
              })}
```

The `aria-sort` attribute goes on the `<th>` (the `columnheader`), which is what the test queries. `created_at` never appears here — it is only the implicit default.

#### Step 3 — Verify + commit

```
npm test -- --testPathPattern='admin-documents-page'
npm run lint
npx prettier --write src/app/admin/documents/page.tsx src/__tests__/admin-documents-page.test.tsx
git add src/app/admin/documents/page.tsx src/__tests__/admin-documents-page.test.tsx
git commit -m "feat(admin): URL-as-source-of-truth catalog view with sortable headers"
```

---

### Task 3: Verification sweep

- [ ] Full targeted suites green:
  ```
  npm test -- --testPathPattern='admin-documents'
  ```
- [ ] Lint + format clean across the whole change:
  ```
  npm run lint
  npm run format:check
  ```
- [ ] Manual smoke (dev server): from the acceptance criterion — sort by Year, filter to Spanish 2023 docs, **copy the URL** and open it in a fresh tab (identical view), **refresh** (view preserved), **back/forward** (view preserved, no history spam because we use `router.replace`), and click the active header a third time to return to default order in one click. Confirm the inbound `?collectionId=` deep link still lands filtered.
- [ ] Confirm there is exactly one list-fetch trigger: change a filter and verify the network shows a single `/api/admin/documents?…` request (no double fetch from a leftover imperative `load`).

If all green, the branch is ready for review. No migration, no backfill, no deploy-ordering concerns (pure app-tier change).

---

## Notes / decisions

- **Why URL-as-source-of-truth, not hybrid:** deriving `filters/sort/page` from `useSearchParams` and firing a single URL-keyed effect removes the class of bugs where component state and the URL disagree, and guarantees shareable/refresh-safe views with no double-fetch. The `reqSeq` guard still protects against out-of-order responses when the URL changes rapidly.
- **`router.replace`, not `push`:** filter/sort/page tweaks should not spam browser history (spec §3).
- **Injection safety:** sort column + direction are only ever taken from the `SORT_COLUMNS` constant and the `'asc'|'desc'` literal — never from a bound param — so no user string reaches the SQL text.
- **Known benign edge — back/forward keeps the selection:** `setQuery` clears `selected`, but a browser back/forward changes the URL without going through `setQuery`, so a checkbox selection can survive a view change until the refetched page renders. Harmless (selected ids simply may not be visible; bulk actions still target the chosen ids) — accepted, do not add code for it.
- **DRY / YAGNI:** one `setQuery` writer backs filters, sort, and pagination; no new endpoints, no indexes, no multi-sort.
