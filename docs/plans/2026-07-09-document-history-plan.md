# Document History Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lazy-loaded History panel on the document editor showing every audited change to the document (who · what · when, expandable before→after), backed by one new read-only endpoint.

**Architecture:** One query function over the existing `audit_log` table (no schema changes, no new writers), one App Router route following the repo's `route → initializeDatabase → query fn` convention, and a self-contained `<details>` panel appended to the editor page that fetches on first expand.

**Tech Stack:** Next.js 16 App Router, TypeORM raw SQL, Jest (jsdom + `*.db.test.ts`).

**Spec:** `docs/superpowers/specs/2026-07-09-document-history-design.md`

**⚠ Sequencing:** Execute AFTER the review-throughput plan (`docs/plans/2026-07-09-review-throughput-plan.md`) has fully landed — both modify `src/app/admin/documents/[id]/page.tsx` and `src/__tests__/admin-editor.test.tsx`.

---

## Context for the implementer (read first)

**Repo rules (executors do NOT inherit CLAUDE.md — restated here):**
- API route convention: `src/app/api/<name>/route.ts` → `initializeDatabase()` → query fn in `src/db/queries/<fn>.ts`. Copy the shape of `src/app/api/admin/documents/[id]/route.ts` (auth via `requireIdentity`, UUID validation, `internalError` helper).
- Arrow-function components; inline styles; `adminFetch` for client calls; native `title` tooltips.
- `npx prettier --write` touched files before each commit; `npm run lint` clean; **no Co-Authored-By trailers**.
- DB tests: `npm run test:db -- --testPathPattern='<name>'` (needs local docker `askwri-pg`; script serializes with `--runInBand` and sets `RUN_CORPUS_TESTS=1`). jsdom: `npm test -- --testPathPattern='<name>'`.

**audit_log facts (verified inventory — trust these):**
- Schema: `id bigserial, actor_user_id uuid NULL, source text ('human'|'system' only), action text, entity_type text, entity_id uuid NULL, before jsonb NULL, after jsonb NULL, at timestamptz default now()`. Index on `(entity_type, entity_id)`. `users.username` exists for the actor join.
- Rows matched by a document's history, per writer:
  - `entity_type='document' AND entity_id=X`: field updates (`action='update'`), lifecycle (`action='lifecycle'`, before/after `{status}`), summary edits (`action='update'`, entity_type is `document_summary` — **check**: summary audits use `entity_type='document_summary'` with `entity_id = document id`, so widen the IN list), tag decisions (`action='tag_decision'`), purge tombstones (`action='delete'`, after NULL).
  - `entity_type='documents'` (plural — Python intake writer) `AND entity_id=X`: intake registration (`action='import'`).
  - `entity_type='ingestion_job' AND entity_id IN (SELECT id FROM ingestion_jobs WHERE document_id=X)`: re-ingest requests (`action='create'`, after `{documentId, status:'queued'}`).
  - `entity_type='collection' AND (after->'addedDocumentIds' @> to_jsonb(X::text) OR before->>'removedDocumentId' = X::text)`: collection membership changes (`action='collection_change'`).
- **Deferred (unattributable/fragile — do NOT include):** bulk CSV-import summary rows (`entity_id` NULL, counts only — no per-doc reference exists) and duplicate-skip intake rows (linkable only via an external_id string in `after->>'of'`). Note both in a code comment on the query.
- audit_log is small (hundreds of rows); the jsonb-containment OR clause needs no index work.

**Editor page state (post review-throughput plan):** sections end with Collections; the History panel goes after it. The page's fetch mock in `src/__tests__/admin-editor.test.tsx` is `setupFetchMock(documentOverride?, queueItems?)` — extend with a third optional param for history, defaulting so existing tests are unaffected (the panel is collapsed by default and must not fetch on mount, so existing tests never hit the URL anyway).

---

### Task 1: Query function + route

**Files:**
- Create: `src/db/queries/documentHistory.ts`
- Create: `src/app/api/admin/documents/[id]/history/route.ts`
- Test: `src/__tests__/document-history.db.test.ts`

- [ ] **Step 1: Write the failing DB test.** Model the fixture/cleanup pattern on `src/__tests__/admin-documents.db.test.ts` (DATABASE_URL gating, per-test doc INSERT, `finally` cleanup, `identity` const). Seed one document plus:
  - a `users` row + an `entity_type='document', action='update'` audit row with that `actor_user_id`, `before/after={title:…}`, `source='human'`
  - an `entity_type='document', action='lifecycle'` row
  - an `entity_type='documents', action='import', source='system', actor_user_id=NULL` row (intake-style)
  - an `ingestion_jobs` row for the doc + an `entity_type='ingestion_job', action='create'` audit row with the job's id
  - an `entity_type='collection', action='collection_change'` row whose `after={"addedDocumentIds":["<doc id>"]}`
  - one unrelated audit row for a different entity id (must NOT appear)

```ts
it('returns all attributable events for the doc, newest first, with actor resolution', async () => {
  const { total, entries } = await getDocumentHistory(docId, { limit: 50, offset: 0 })
  expect(total).toBe(5)
  expect(entries.map((e) => e.action)).toEqual(
    expect.arrayContaining(['update', 'lifecycle', 'import', 'create', 'collection_change']),
  )
  const update = entries.find((e) => e.action === 'update')!
  expect(update.actor).toBe('history_test_user')     // username via JOIN
  const intake = entries.find((e) => e.action === 'import')!
  expect(intake.actor).toBe('system')                 // NULL actor falls back to source
  const ats = entries.map((e) => +new Date(e.at))
  expect(ats).toEqual([...ats].sort((a, b) => b - a)) // at DESC
})

it('paginates with limit/offset and reports the true total', async () => {
  const page = await getDocumentHistory(docId, { limit: 2, offset: 0 })
  expect(page.entries).toHaveLength(2)
  expect(page.total).toBe(5)
})
```

- [ ] **Step 2: Run to verify failure.** `npm run test:db -- --testPathPattern='document-history'` → FAIL (module not found).

- [ ] **Step 3: Implement the query fn.**

```ts
// src/db/queries/documentHistory.ts
import { AppDataSource } from '../data-source'

export interface HistoryEntry {
  at: string
  action: string
  entityType: string
  actor: string          // username, or the row's source ('human'|'system') when unattributed
  source: string
  before: Record<string, any> | null
  after: Record<string, any> | null
}

export interface DocumentHistoryResult {
  total: number
  entries: HistoryEntry[]
}

// Matches every audit row attributable to the document. Deliberately excluded
// (no recoverable document reference in the row): bulk CSV-import summary rows
// (entity_id NULL, counts only) and intake duplicate-skip rows (external_id
// string in after->>'of' only). Python writers use entity_type='documents'
// (plural) — both spellings are matched.
const SCOPE = `
  (al.entity_type IN ('document', 'documents', 'document_summary') AND al.entity_id = $1)
  OR (al.entity_type = 'ingestion_job'
      AND al.entity_id IN (SELECT id FROM ingestion_jobs WHERE document_id = $1))
  OR (al.entity_type = 'collection'
      AND (al.after -> 'addedDocumentIds' @> to_jsonb($1::text)
           OR al.before ->> 'removedDocumentId' = $1::text))`

export async function getDocumentHistory(
  documentId: string,
  { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<DocumentHistoryResult> {
  const entries = await AppDataSource.query(
    `SELECT al.at, al.action, al.entity_type AS "entityType",
            COALESCE(u.username, al.source) AS actor,
            al.source, al.before, al.after
     FROM audit_log al
     LEFT JOIN users u ON u.id = al.actor_user_id
     WHERE ${SCOPE}
     ORDER BY al.at DESC, al.id DESC
     LIMIT $2 OFFSET $3`,
    [documentId, limit, offset],
  )
  const [row] = await AppDataSource.query(
    `SELECT count(*)::int AS total FROM audit_log al WHERE ${SCOPE}`,
    [documentId],
  )
  return { total: row?.total ?? 0, entries }
}
```

(Verified: `updateDocumentSummary` writes `entity_type='document_summary'` with `entity_id = document id` — the IN list above is correct as written.)

- [ ] **Step 4: Implement the route** — copy the auth/validation shape of the sibling `[id]/route.ts`:

```ts
// src/app/api/admin/documents/[id]/history/route.ts
// GET /api/admin/documents/[id]/history?limit=20&offset=0
// Imports: copy the sibling routes verbatim and adjust for one extra directory level —
// they import from '../../../../../../db/data-source' and
// '../../../../../../lib/auth/identity' (this route sits one level deeper: add one more '../').
// There is NO '@/db/init' module — follow the siblings, not this sketch.
```

Handler: `requireIdentity(req)`; UUID-validate `id` (copy the sibling's regex/404 behavior); parse `limit` (default 20, cap 500) and `offset` (default 0) from `req.nextUrl.searchParams`; `NextResponse.json({ ok: true, ...await getDocumentHistory(id, { limit, offset }) })`; wrap in the sibling's error helper. **Follow the sibling route's exact imports/helpers rather than the sketch above.**

- [ ] **Step 5: Run tests.** `npm run test:db -- --testPathPattern='document-history'` → PASS. Also run `npm run test:db` (full) → all pass.
- [ ] **Step 6: Lint + format + commit.**

```bash
npx eslint src/db/queries/documentHistory.ts 'src/app/api/admin/documents/[id]/history/route.ts' src/__tests__/document-history.db.test.ts
npx prettier --write src/db/queries/documentHistory.ts 'src/app/api/admin/documents/[id]/history/route.ts' src/__tests__/document-history.db.test.ts
git add src/db/queries/documentHistory.ts 'src/app/api/admin/documents/[id]/history/route.ts' src/__tests__/document-history.db.test.ts
git commit -m "feat(admin): document history endpoint over audit_log (attributable events, actor resolution)"
```

---

### Task 2: History panel on the editor

**Files:**
- Modify: `src/app/admin/documents/[id]/page.tsx` (new section after Collections)
- Test: `src/__tests__/admin-editor.test.tsx` (extend)

- [ ] **Step 1: Write the failing tests.** Extend `setupFetchMock` with a third optional param `history: { total: number; entries: any[] } = { total: 0, entries: [] }` answering `url.includes('/history')`. **Placement matters:** the mock's existing `url.startsWith('/api/admin/documents/test-doc-id-123')` branch also matches `…/history?…`, so the new `/history` check MUST come before that broad prefix branch — otherwise history fetches silently get the document detail payload and the tests fail with confusing shape mismatches. Tests:

```tsx
it('does not fetch history until the panel is expanded', async () => {
  const fetchMock = setupFetchMock()
  render(…)
  await screen.findByText('Document editor')
  expect(fetchMock.mock.calls.map(([u]) => String(u))).not.toContainEqual(expect.stringContaining('/history'))
})

it('fetches and renders one-liners on first expand', async () => {
  setupFetchMock(undefined, [], {
    total: 2,
    entries: [
      { at: new Date().toISOString(), action: 'update', entityType: 'document', actor: 'jane', source: 'human', before: { title: 'Old' }, after: { title: 'New' } },
      { at: new Date().toISOString(), action: 'lifecycle', entityType: 'document', actor: 'jane', source: 'human', before: { status: 'needs_review' }, after: { status: 'searchable' } },
    ],
  })
  render(…)
  fireEvent.click(await screen.findByText('History'))
  expect(await screen.findByText(/jane · updated title/)).toBeInTheDocument()
  expect(screen.getByText(/status → searchable/)).toBeInTheDocument()
})

it('expands an entry to show before/after values', async () => {
  // same fixture; click the one-liner → 'Old' and 'New' visible
})

it('shows Show all when total exceeds the page', async () => {
  // total: 25, entries: 20 stubs → link "Show all (25)" present
})

it('renders the empty state', async () => {
  // total 0 → expand → "No recorded changes."
})
```

- [ ] **Step 2: Run to verify the new tests fail.** `npm test -- --testPathPattern='admin-editor'`.

- [ ] **Step 3: Implement the panel** in `documents/[id]/page.tsx` (keep it in-file — it's one `<details>` section using page-local state, consistent with the page's other sections):

State + fetch-on-expand:

```tsx
const [history, setHistory] = useState<{ total: number; entries: any[] } | null>(null)
const [historyError, setHistoryError] = useState<string | null>(null)
const historyFetched = useRef(false)

const loadHistory = async (limit = 20) => {
  try {
    const body = await adminFetch<{ total: number; entries: any[] }>(
      `/api/admin/documents/${id}/history?limit=${limit}`,
    )
    setHistory({ total: body.total, entries: body.entries ?? [] })
  } catch (err: any) {
    setHistoryError(err.message)
  }
}
```

Rendering helpers (top of file, next to the other small helpers):

```tsx
const HISTORY_VERB: Record<string, string> = {
  update: 'updated',
  lifecycle: 'status',
  tag_decision: 'tag decision',
  collection_change: 'collections',
  import: 'import',
  create: 'created',
  delete: 'deleted',
}

const historyLine = (e: any) => {
  const verb = HISTORY_VERB[e.action] ?? e.action
  if (e.action === 'lifecycle') return `${e.actor} · status → ${e.after?.status ?? '?'}`
  const fields = e.after ? Object.keys(e.after).slice(0, 4).join(', ') : ''
  return `${e.actor} · ${verb}${fields ? ` ${fields}` : ''}`
}

const historyWhen = (at: string) => {
  const ms = Date.now() - +new Date(at)
  const h = Math.floor(ms / 3600000)
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h ago`
  if (h < 24 * 7) return `${Math.floor(h / 24)}d ago`
  return new Date(at).toLocaleDateString()
}
```

Panel JSX after the Collections section:

```tsx
{/* History panel — lazy: fetches on first expand */}
<section style={{ marginBottom: 32 }}>
  <details
    onToggle={(e) => {
      if ((e.target as HTMLDetailsElement).open && !historyFetched.current) {
        historyFetched.current = true
        loadHistory()
      }
    }}
  >
    <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 18 }}>History</summary>
    <Text style={{ margin: '8px 0', color: '#555', fontSize: 13 }}>
      Every recorded change to this document — who, what, and when. Automated pipeline
      steps are not recorded; imports and intake events are.
    </Text>
    {historyError && <Text style={{ color: '#C11101' }}>{historyError}</Text>}
    {!history && !historyError && <Text style={{ color: '#888', fontSize: 13 }}>Loading…</Text>}
    {history && history.entries.length === 0 && <Text style={{ color: '#555' }}>No recorded changes.</Text>}
    {history &&
      history.entries.map((e, i) => (
        <details key={i} style={{ padding: '6px 0', borderBottom: '1px solid #eee', fontSize: 13 }}>
          <summary style={{ cursor: 'pointer' }}>
            {historyLine(e)} · <span style={{ color: '#888' }}>{historyWhen(e.at)}</span>
          </summary>
          <table style={{ borderCollapse: 'collapse', margin: '6px 0 6px 16px', fontSize: 12 }}>
            <tbody>
              {Array.from(new Set([...Object.keys(e.before ?? {}), ...Object.keys(e.after ?? {})])).map((k) => (
                <tr key={k}>
                  <td style={{ padding: '2px 8px', fontWeight: 500, verticalAlign: 'top' }}>{k}</td>
                  <td style={{ padding: '2px 8px', color: '#C11101', verticalAlign: 'top' }}>
                    {e.before?.[k] == null ? '—' : typeof e.before[k] === 'string' ? e.before[k] : JSON.stringify(e.before[k])}
                  </td>
                  <td style={{ padding: '2px 8px', color: '#0A6640', verticalAlign: 'top' }}>
                    {e.after?.[k] == null ? '—' : typeof e.after[k] === 'string' ? e.after[k] : JSON.stringify(e.after[k])}
                  </td>
                </tr>
              ))}
              {!e.before && !e.after && (
                <tr><td style={{ padding: '2px 8px', color: '#888' }}>no field detail recorded</td></tr>
              )}
            </tbody>
          </table>
        </details>
      ))}
    {history && history.total > history.entries.length && (
      <button onClick={() => loadHistory(history.total)} style={{ textDecoration: 'underline', marginTop: 8, fontSize: 13 }}>
        Show all ({history.total})
      </button>
    )}
  </details>
</section>
```

- [ ] **Step 4: Run tests.** `npm test -- --testPathPattern='admin-editor'` → ALL pass (existing + new).
- [ ] **Step 5: Lint + format + commit.**

```bash
npx eslint 'src/app/admin/documents/[id]/page.tsx' src/__tests__/admin-editor.test.tsx
npx prettier --write 'src/app/admin/documents/[id]/page.tsx' src/__tests__/admin-editor.test.tsx
git add 'src/app/admin/documents/[id]/page.tsx' src/__tests__/admin-editor.test.tsx
git commit -m "feat(admin): lazy-loaded History panel on the document editor"
```

---

### Task 3: Verification sweep

- [ ] **Step 1:** `npm test` → all pass (db-suite flakes under parallel workers → confirm via `npm run test:db`).
- [ ] **Step 2:** `npm run lint` → clean; prettier check on changed files → clean.
- [ ] **Step 3:** `npx next build --webpack` → green.
- [ ] **Step 4:** Manual smoke: open a document that has edits from this session → expand History → entries show with usernames; expand one → before/after; edit a field, re-expand (reload page) → new entry appears.
- [ ] **Step 5:** Fix anything found; commit.
