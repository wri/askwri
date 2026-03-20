# Cite Mode Performance Improvements

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce cite mode end-to-end latency from ~10s to ~5s and eliminate wasted API calls, bundle bloat, and redundant network traffic.

**Architecture:** Five improvements across different layers. Tasks 1→2 are sequential (Task 2 replaces the catalog ref guard from Task 1 with SWR). Tasks 3, 4, and 5 are independent and can be parallelized.

**Tech Stack:** Next.js 16, React 19, SWR (new dependency), Chakra UI, @worldresources/wri-design-systems

**QA Report:** `.gstack/qa-reports/qa-report-localhost-2026-03-20.md` (health score: 52/100)

**Already shipped:** Improvement #1 — batch relates calls (PR #119, `gutelius/batch-relates-calls`)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/app/results/page.tsx` | Modify | Add refs to deduplicate effects; replace catalog fetch with SWR hook |
| `src/lib/llamaindex-client.ts` | Modify | Add in-flight request deduplication |
| `src/hooks/useCatalog.ts` | Create | SWR-based catalog hook with 1-hour revalidation |
| `next.config.js` | Modify | Add `optimizePackageImports` for react-icons |
| `src/app/components/results/ResultsTable.tsx` | Modify | Add responsive table wrapper + mobile column hiding |

---

## Task 1: Deduplicate API Calls (React Strict Mode)

**Problem:** React strict mode double-mounts components in dev, causing `/api/llamaindex`, `/api/catalog`, and `/api/cite-mode-query-logs` to each fire twice per search. The llamaindex duplication is especially costly — 6.3s of redundant vector search + BM25 + reranking.

**Files:**
- Modify: `src/lib/llamaindex-client.ts`
- Modify: `src/app/results/page.tsx`

### 1a: Deduplicate llamaindex calls at the client level

- [ ] **Step 1: Add in-flight request deduplication to `llamaindex-client.ts`**

Add a `Map` that tracks in-flight promises by query+mode key. If the same request is already in flight, return the existing promise instead of firing a new one.

```typescript
// src/lib/llamaindex-client.ts — add at top of file, after imports
const inflightRequests = new Map<string, Promise<any>>()

// Replace the callLlamaIndexService function body:
async function callLlamaIndexService(
  query: string,
  mode: 'answer' | 'cite',
  options: LlamaIndexQueryOptions = {},
): Promise<any> {
  const key = `${mode}:${query.trim()}:${JSON.stringify(options)}`

  const existing = inflightRequests.get(key)
  if (existing) return existing

  const promise = (async () => {
    const response = await fetch('/api/llamaindex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, mode, ...options }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        `LlamaIndex service error: ${response.status} - ${errorData.error || 'Unknown error'}`,
      )
    }

    return response.json()
  })()
    .finally(() => {
      inflightRequests.delete(key)
    })

  inflightRequests.set(key, promise)
  return promise
}
```

- [ ] **Step 2: Verify the app still loads search results**

Run: `npm run dev` and search for any query. Verify only 1 `POST /api/llamaindex` appears in server logs (not 2).

- [ ] **Step 3: Commit**

```bash
git add src/lib/llamaindex-client.ts
git commit -m "fix: deduplicate in-flight llamaindex requests"
```

### 1b: Deduplicate catalog fetch and query logging

- [ ] **Step 4: Add ref guards to `page.tsx` useEffect hooks**

In `src/app/results/page.tsx`, add refs to prevent double-firing of the catalog fetch and query log effects.

```typescript
// Add near the top of AskWriAppContent, with other state declarations:
const catalogFetchedRef = useRef(false)
const queryLoggedRef = useRef('')
```

Update the catalog useEffect (lines 62-73):

```typescript
useEffect(() => {
  if (catalogFetchedRef.current) return
  catalogFetchedRef.current = true
  ;(async () => {
    const res = await fetch('/api/catalog', { cache: 'no-store' })
    if (!res.ok) return
    const j = await res.json()
    const normed = (j.items as any[]).map(normalizeCatalogRow)
    setCatalog(normed)
    setIndex(buildCatalogIndex(normed))
  })()
}, [])
```

Update the query logging useEffect (lines 375-394):

```typescript
useEffect(() => {
  if (pageDocs.length === 0) return
  const logKey = `${query}:${pageDocs.length}`
  if (queryLoggedRef.current === logKey) return
  queryLoggedRef.current = logKey

  const topTenResults = JSON.stringify(
    pageDocs
      .slice(0, 10)
      .map((doc) => titleFrom(doc, matchCatalogRow(doc, index))),
  )

  fetch('/api/cite-mode-query-logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topTenResults }),
  })
}, [pageDocs, query])
```

Note: The `matchCatalogRow(doc, index)` call inside this effect has a pre-existing race with `index` being null when catalog hasn't loaded yet. This is not introduced by this change — the original code has the same issue. It's harmless (just means titles in logs may lack catalog enrichment on fast page loads).

Also add `useRef` to the React import at line 5:

```typescript
import React, { useMemo, useState, useEffect, useRef, Suspense } from 'react'
```

- [ ] **Step 5: Reset queryLoggedRef when a new query runs**

In `runQuery()` function, add a reset so new queries can log:

```typescript
function runQuery(q = query) {
  if (!q.trim()) return
  // ... existing cache check ...
  queryLoggedRef.current = ''  // reset so the new query gets logged
  // ... rest of function ...
}
```

- [ ] **Step 6: Verify deduplication**

Run: `npm run dev` and search. Check server logs:
- Expected: 1x `GET /api/catalog`, 1x `POST /api/llamaindex`, 1x `POST /api/cite-mode-query-logs`
- Previously: 2x each

- [ ] **Step 7: Commit**

```bash
git add src/app/results/page.tsx
git commit -m "fix: prevent duplicate catalog fetch and query logging from strict mode"
```

---

## Task 2: Cache Catalog Client-Side with SWR

**Depends on:** Task 1b (this task removes the `catalogFetchedRef` added there, replacing it with SWR's built-in deduplication).

**Problem:** The 395KB catalog is fetched with `cache: 'no-store'` on every results page load. The data is essentially static (document metadata CSV).

**Files:**
- Create: `src/hooks/useCatalog.ts`
- Modify: `src/app/results/page.tsx`
- Modify: `package.json` (add `swr` dependency)

- [ ] **Step 1: Install SWR**

```bash
npm install swr
```

- [ ] **Step 2: Create `useCatalog` hook**

```typescript
// src/hooks/useCatalog.ts
import { useMemo } from 'react'
import useSWR from 'swr'
import { buildCatalogIndex, normalizeCatalogRow } from '@/app/utils/utils'

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Catalog fetch failed: ${r.status}`)
    return r.json()
  })

export function useCatalog() {
  const { data, error, isLoading } = useSWR('/api/catalog', fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 3600000, // 1 hour
  })

  const catalog = useMemo(
    () => (data?.items ? (data.items as any[]).map(normalizeCatalogRow) : []),
    [data],
  )
  const index = useMemo(
    () => (catalog.length > 0 ? buildCatalogIndex(catalog) : null),
    [catalog],
  )

  return { catalog, index, error, isLoading }
}
```

- [ ] **Step 3: Replace catalog fetch in `page.tsx`**

Remove the catalog `useState` + `useEffect` (lines 58-73) and replace with:

```typescript
const { catalog, index } = useCatalog()
```

Remove these lines:
- `const [catalog, setCatalog] = useState<any[]>([])`
- `const [index, setIndex] = useState<...>(null)`
- The entire `useEffect` that fetches `/api/catalog`
- The `catalogFetchedRef` from Task 1 (no longer needed since SWR handles dedup)

- [ ] **Step 4: Verify catalog still works**

Run: `npm run dev` and search. Verify:
- Catalog fetched once on first page load
- Subsequent searches reuse the cached catalog (no new `/api/catalog` requests)
- Document titles, authors, and summaries still render correctly

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCatalog.ts src/app/results/page.tsx package.json package-lock.json
git commit -m "perf: cache catalog client-side with SWR (1hr revalidation)"
```

---

## Task 3: Optimize React Icons Bundle (14MB → <100KB)

**Independent** — no dependency on Tasks 1 or 2.

**Problem:** 8 react-icons barrel imports load 14.4MB of JS in dev. The app uses react-icons v5.5.0 which supports tree-shaking in production builds, but dev bundles are still bloated. Only 15 icons are actually used across 9 files.

**Files:**
- Modify: `next.config.js`

**Approach:** Next.js has built-in `optimizePackageImports` which automatically transforms barrel imports into direct imports at build time — both dev and prod. This is a one-line config change vs. modifying 9 component files.

- [ ] **Step 1: Add `optimizePackageImports` to `next.config.js`**

```javascript
// next.config.js — add optimizePackageImports as a top-level key:
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  optimizePackageImports: ['react-icons'],
  // ... rest of config (env, headers, etc.)
}
```

Note: `optimizePackageImports` is a top-level config key in Next.js 14+ (not under `experimental`). Adding `react-icons` tells the bundler to transform `import { MdChat } from 'react-icons/md'` into a direct import of just that icon, both in dev and prod.

- [ ] **Step 2: Restart dev server and verify icons render**

```bash
npm run dev
```

Visit cite mode results and answer mode. Verify all 15 icons appear correctly. Check the terminal/browser network tab — react-icons chunks should be dramatically smaller.

- [ ] **Step 3: Verify production build**

```bash
npx next build
```

Check output for bundle sizes. The 14MB of react-icons chunks should be gone.

- [ ] **Step 4: Commit**

```bash
git add next.config.js
git commit -m "perf: optimize react-icons barrel imports via Next.js config (14MB → <100KB)"
```

### Reference: All 15 icons used

If `optimizePackageImports` doesn't work with react-icons v5 barrel structure, fall back to manually updating imports in these 9 files:

| Icon | Family | Files |
|------|--------|-------|
| `FaChevronRight` | fa6 | SupportingCitations |
| `FaChevronLeft` | fa6 | SupportingCitations |
| `FaQuoteRight` | fa6 | SupportingCitations |
| `FaArrowRightLong` | fa6 | Landing, AISearchForm |
| `FaThumbsUp` | fa6 | AnswerPanel, SelectableResultRow |
| `FaThumbsDown` | fa6 | AnswerPanel, SelectableResultRow |
| `FaInfoCircle` | fa | AnswerPanel, results/index |
| `FaChevronUp` | fa | ExportActionBar |
| `FiPlus` | fi | Navbar |
| `LuRefreshCcw` | lu | Landing, AISearchForm |
| `MdChat` | md | AnswerPanel, ResultsTable |
| `IoIosCopy` | io | SupportingCitations, AnswerPanel, SelectableResultRow |
| `IoMdOpen` | io | SupportingCitations |
| `AiFillThunderbolt` | ai | AnswerPanel, results/index |
| `HiCurrencyDollar` | hi2 | AnswerPanel, results/index |

---

## Task 4: Mobile Responsive Results Table

**Independent** — no dependency on Tasks 1-3.

**Problem:** The results table renders 5 columns (Publication, Summary, Relevance, How is this relevant?, Actions) at all viewport sizes. On 375px mobile viewports, the table overflows horizontally and is unreadable.

**Files:**
- Modify: `src/app/components/results/ResultsTable.tsx`

**Context:** The table uses `@worldresources/wri-design-systems` `Table` component with a static `columns` array (defined at module level, lines 36-72). The columns are:
1. `publication_title` — Publication
2. `short_summary` — Summary (AI generated)
3. `relevance` — Relevance (AI generated)
4. `how_relevant` — How is this relevant? (AI generated)
5. `row_actions` — (empty label, action buttons)

- [ ] **Step 1: Add a CSS module for responsive column hiding**

Create `src/app/components/results/ResultsTable.module.css`:

```css
/* Hide "Relevance" and "How is this relevant?" columns on mobile */
@media (max-width: 768px) {
  .responsiveTable th:nth-child(4),
  .responsiveTable td:nth-child(4),
  .responsiveTable th:nth-child(5),
  .responsiveTable td:nth-child(5) {
    display: none;
  }
}

/* Also hide "Relevance" on tablets — it's the least useful column */
@media (max-width: 1024px) {
  .responsiveTable th:nth-child(4),
  .responsiveTable td:nth-child(4) {
    display: none;
  }
}

.tableWrapper {
  width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
```

- [ ] **Step 2: Import and apply the CSS module in `ResultsTable.tsx`**

```typescript
// Add import at top of ResultsTable.tsx:
import styles from './ResultsTable.module.css'
```

Wrap the existing `<Table>` component (line 192) in a scrollable div:

```typescript
<div className={styles.tableWrapper}>
  <div className={styles.responsiveTable}>
    <Table
      variant='full-width'
      columns={columns as { key: string; label: string; sortable?: boolean }[]}
      data={dataByPage}
      renderRow={selectableRenderRow}
      selectedRows={selectedRows}
      onAllItemsSelected={onAllItemsSelected}
      selectable
      onPageChange={setCurrentPage}
      pagination={{
        totalItems,
        currentPage,
        pageSize,
        showItemCount: false,
      }}
    />
  </div>
</div>
```

Note: The CSS `nth-child` selectors target columns 4 and 5 (1-indexed, accounting for the checkbox column that `selectable` adds as column 1). Verify the column indices match by inspecting the rendered HTML — the checkbox column shifts all indices by 1.

- [ ] **Step 3: Test at 375px viewport**

```bash
npm run dev
```

Open browser dev tools → toggle device toolbar → select iPhone SE (375px) or similar. Navigate to cite mode results. Verify:
- Publication and Summary columns are visible and readable
- Relevance and How is this relevant? columns are hidden
- Table doesn't overflow horizontally
- If table still overflows, the `tableWrapper` scroll kicks in as fallback

- [ ] **Step 4: Test at desktop (1280px)**

Verify all 5 columns are visible at full width. No regressions.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/results/ResultsTable.tsx src/app/components/results/ResultsTable.module.css
git commit -m "fix: make results table responsive on mobile viewports"
```

---

## Task 5: Remove Dead `/api/search` Call

**Problem:** Network traces show `POST /api/search → 404`. Investigation found NO source code reference to this endpoint — it's likely from a browser extension or external script.

**Files:**
- None (no code change needed)

- [ ] **Step 1: Verify in clean browser**

Open `http://localhost:3000` in an incognito/private window with extensions disabled. Check network tab for `/api/search` requests.

- [ ] **Step 2: If the call appears in incognito, search more broadly**

```bash
grep -r "api/search" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.html" .
```

Also check third-party scripts loaded via `<script>` tags in layout.tsx.

- [ ] **Step 3: Document finding**

If it's a browser extension: note in the QA report as "false positive — browser extension". If it's from source: fix the reference.

---

## Expected Impact

| Improvement | Before | After | Savings |
|-------------|--------|-------|---------|
| Batch relates (DONE) | 24 API calls, ~6.7s | 1 call, ~2s | 4.7s, 24x cost |
| Deduplicate API calls | 2x llamaindex + catalog + logs | 1x each | ~4s, 395KB |
| Cache catalog | 395KB per page load | 0 (cached) | 395KB/load |
| React icons bundle | 14.4MB dev JS | <100KB | 14.3MB |
| Mobile responsive | Horizontal overflow | Readable table | UX |

**Total cite mode latency:** ~10s → ~5s (50% reduction)
