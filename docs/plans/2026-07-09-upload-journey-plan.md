# Upload Journey Implementation Plan

**For agentic workers:** Execute tasks in order. Each task is TDD (write the failing test first, then the implementation), self-contained, and ends with a green test run + a commit. Do NOT batch tasks together or skip the red step. Copy the code blocks verbatim unless a verified fact below contradicts them.

**Goal:** Turn the bare admin upload page into a drag-and-drop journey: users drop PDFs, see each file's per-file outcome, and watch it move through the pipeline (uploaded → registered/processing → terminal status, or "likely duplicate") live while they stay on the page — all via existing endpoints, no schema or intake-API changes.

**Architecture:** One client component (`src/app/admin/upload/page.tsx`). Session-only React state (an array of `UploadEntry`). A single shared `setInterval` (5 s) polls two existing read endpoints — `GET /api/admin/documents?search=<stem>` (per non-terminal entry) and `GET /api/admin/worker-health` (once per tick, for the duplicate inference). No persistence, no new attribution, no dropzone library.

**Tech Stack:** Next.js 16 App Router client component, React 19 hooks, Chakra (`Box`/`Heading`/`Text`) for layout, plain inline-styled DOM for interactive bits. Jest + jsdom + @testing-library/react for tests.

**Spec:** `docs/superpowers/specs/2026-07-09-upload-journey-design.md` (authoritative). Read it before starting.

---

## Context for the implementer

### Repo rules (non-negotiable)

- **Arrow function components only.** `const UploadPage = () => { ... }` then `export default UploadPage`. Never `function UploadPage()`. (The repo enforces `react/function-component-definition`; the existing page and `Tooltip`/`StatusChip` all follow this.)
- **Inline styles, not CSS files.** Every existing admin component uses `style={{ ... }}` objects. Match that.
- **`adminFetch` for admin JSON GETs.** `src/app/admin/lib/api.ts` wraps `fetch`, handles the 401 → `/admin/login` redirect, throws on `!ok`/`body.ok === false`, and returns the parsed body. Use it for the documents poll.
  - **BUT the intake POST must stay raw `fetch`.** `adminFetch` forces `Content-Type: application/json`, which breaks multipart `FormData` (the browser must set the multipart boundary itself). The current page already uses raw `fetch` for `/api/admin/intake` with its own inline 401 redirect — keep that.
- **Run `npm run format:check` (prettier) before every commit.** If it flags the file, run `npm run format` (or `npx prettier --write <file>`), then re-stage.
- **NEVER add `Co-Authored-By` trailers** to commits.
- One command per Bash call; no `&&`/`;`/redirect chains.

### Verified code facts (file:line)

- **`src/app/admin/upload/page.tsx`** — current page. Arrow component (`:29`). Raw `fetch('/api/admin/intake', { method: 'POST', body: form })` (`:67`). Inline 401 redirect to `/admin/login?next=…` (`:71-73`). Reads `body.uploaded as string[]` on success (`:79`). `loadHealth()` callback hits `/api/admin/worker-health`, reads `body.health` (`:36-46`). `WorkerHealth` interface + `STATUS_STYLES` map are defined at the top (`:9-27`). Uses `Tooltip` from `'../components/Tooltip'` (`:7`). The health panel (`:122-157`) and duplicate-skip intro copy (`:110-120`) must be preserved unchanged.
- **`src/app/api/admin/intake/route.ts`** — validation is **ALL-OR-NOTHING**. Every file is validated before any upload; the first failure returns `NextResponse.json({ ok: false, error: '<one string>' }, { status: 400 })` and nothing lands in intake. Failures: non-`.pdf` name (`:48`), `> 50MB` (`:51`), duplicate filename within the batch (`:57`), failed `%PDF-` magic-byte check (`:65`). On success returns `{ ok: true, uploaded: string[] }` (`:108`). 401 is handled upstream by `requireIdentity`. **Implication:** a bad file in a drop 400s the *entire* batch with a single error and no `uploaded` list — the plan renders that as the page-level `error` and leaves the session list untouched.
- **`src/db/queries/workerHealth.ts`** — `getWorkerHealth()` returns `{ queueDepth, lastProcessedAt, intakeBacklog, status }`. `intakeBacklog` = S3 intake objects with no `documents` row. `:87` computes the stem with `(o.Key ?? '').split('/').pop()!.replace(/\.pdf$/i, '')` — **match this exactly** for our client stem. Two caveats to encode in the duplicate inference (see Task 2):
  1. `intakeBacklog` is **global and coarse** — other users' unregistered files keep it `> 0`, so our inference *under-fires* (a real duplicate isn't flagged while someone else's file is in the queue). Acceptable: we only ever *under*-claim, and the label already says "likely".
  2. In `INTAKE_LOCAL_DIR` mode there is no `DOCUMENTS_S3_BUCKET`, so `countIntakeBacklog` returns `0` unconditionally (`:77`) → `intakeBacklog` is *always* 0 → the inference can *over*-fire locally. This is a **local-dev-only artifact**; note it in a code comment, do not try to fix it.
- **`GET /api/admin/documents`** (`src/app/api/admin/documents/route.ts`) — returns `{ ok: true, items, total }`. Item shape (from `listAdminDocuments`, `src/db/queries/documentsAdmin.ts:88`): `{ id, externalId, title, language, status }`. `search` is **ILIKE substring** across title/external_id/authors/doi/url (`documentsAdmin.ts:70`) — so a poll for `search=<stem>` can return near-matches; we must **exact-match `item.externalId === stem` client-side**. Accepts `limit` (clamped 1–500).
- **`src/app/admin/components/StatusChip.tsx`** — `<StatusChip status={string} />`. `STATUS_META` keys: `draft`, `processing`, `needs_review`, `searchable`, `withdrawn`, `error`. Unknown statuses render with a neutral grey fallback. Reuse this for the per-file live status; do not re-implement status colors.
- **`src/app/admin/components/Tooltip.tsx`** — `<Tooltip help={string}>children</Tooltip>`, native `title` attribute. Reuse for the "likely duplicate" explanation.
- **Editor link path** — `/admin/documents/${id}` (confirmed in `src/app/admin/review/page.tsx:397,468`).
- **Doc statuses** — the lifecycle values are `draft`, `processing`, `needs_review`, `searchable`, `withdrawn`, `error`. A freshly registered row is `draft`. **Terminal** (stop polling that entry): `searchable`, `needs_review`, `error`, `withdrawn`. **Non-terminal** (keep polling): `draft`, `processing`, and "not registered yet".
- **Test conventions** — tests live in `src/__tests__/admin-*.test.tsx`. They render pages wrapped in `<ChakraProvider>` (`src/app/Providers/ChakraProvider`), mock `next/navigation` (`useParams`/`useRouter`/`usePathname`/`useSearchParams`), and mock `global.fetch` with a `jest.fn((url) => …)` that switches on the URL and returns `{ ok, json: () => Promise.resolve(...) }` (see `admin-review-page.test.tsx:6-116`, `admin-editor.test.tsx:1-60`). **There is no existing fake-timers example** — Task 2 introduces one; use the recipe given there.

### State machine (per entry)

```
             (intake 200, filename in `uploaded`)
                          │
                          ▼
                     ┌─────────┐   poll: no exact externalId match,
                     │uploaded │──┐ elapsed ≤ 90s OR backlog > 0 (stay)
                     └─────────┘  │
              poll: exact  │      │ poll: elapsed > 90s AND backlog === 0
              match found  │      ▼
                          │  ┌───────────────┐  (terminal)
                          │  │likely-duplicate│
                          │  └───────────────┘
                          ▼
              docStatus ∈ {draft, processing}   ── keep polling ──┐
                          │                                        │
                          ▼                                        │
              docStatus ∈ {searchable, needs_review,   ◄──────────┘
                           error, withdrawn}  (terminal)
```

The single shared interval runs while ANY entry is non-terminal; it stops (cleanup) when all entries are terminal or the list is empty. Poll failures are swallowed — the entry keeps its last known state.

---

## Task 1 — Dropzone + per-file upload results (incl. batch-400 handling)

Replace the bare `<input>` + Upload button with a styled drop target that auto-uploads on drop or file-picker selection, appends accepted files to a session list, and renders the ALL-OR-NOTHING batch-400 error without touching the list.

### 1a. Write the failing test

Create `src/__tests__/admin-upload-page.test.tsx`:

```tsx
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import UploadPage from '@/app/admin/upload/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

jest.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => '/admin/upload',
  useSearchParams: () => ({ get: () => null }),
}))

const healthOk = {
  ok: true,
  json: () =>
    Promise.resolve({
      ok: true,
      health: {
        queueDepth: 0,
        lastProcessedAt: null,
        intakeBacklog: 0,
        status: 'idle',
      },
    }),
}

// Build a File whose .name ends in .pdf (contents irrelevant — server validates,
// which we mock).
const pdf = (name: string) => new File(['%PDF-1.4'], name, { type: 'application/pdf' })

const renderPage = () =>
  render(
    <ChakraProvider>
      <UploadPage />
    </ChakraProvider>,
  )

afterEach(() => {
  jest.restoreAllMocks()
})

describe('UploadPage — dropzone + per-file results', () => {
  it('drops PDFs, uploads them, and lists each accepted file', async () => {
    const fetchMock = jest.fn((url: string, init?: any) => {
      if (url === '/api/admin/worker-health') return Promise.resolve(healthOk)
      if (url === '/api/admin/intake') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, uploaded: ['a.pdf', 'b.pdf'] }),
        })
      }
      // documents poll — nothing registered yet
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, items: [], total: 0 }),
      })
    })
    global.fetch = fetchMock as any
    renderPage()

    const zone = screen.getByLabelText('Drop PDFs here or click to choose files')
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [pdf('a.pdf'), pdf('b.pdf')] } })
    })

    await screen.findByText('a.pdf')
    expect(screen.getByText('b.pdf')).toBeInTheDocument()
    // POST body was multipart FormData, not JSON
    const post = fetchMock.mock.calls.find((c) => c[0] === '/api/admin/intake')!
    expect(post[1].body).toBeInstanceOf(FormData)
  })

  it('rejects non-PDF drops with a message and does not upload them', async () => {
    const fetchMock = jest.fn((url: string) =>
      url === '/api/admin/worker-health'
        ? Promise.resolve(healthOk)
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, items: [] }) }),
    )
    global.fetch = fetchMock as any
    renderPage()

    const zone = screen.getByLabelText('Drop PDFs here or click to choose files')
    await act(async () => {
      fireEvent.drop(zone, {
        dataTransfer: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
      })
    })

    await screen.findByText(/Skipped non-PDF/i)
    expect(fetchMock).not.toHaveBeenCalledWith('/api/admin/intake', expect.anything())
  })

  it('renders the batch-400 error and leaves the session list untouched', async () => {
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/admin/worker-health') return Promise.resolve(healthOk)
      if (url === '/api/admin/intake') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () =>
            Promise.resolve({ ok: false, error: 'big.pdf: file too large (max 52428800 bytes)' }),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, items: [] }) })
    })
    global.fetch = fetchMock as any
    renderPage()

    const zone = screen.getByLabelText('Drop PDFs here or click to choose files')
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [pdf('ok.pdf'), pdf('big.pdf')] } })
    })

    await screen.findByText(/big\.pdf: file too large/i)
    // ALL-OR-NOTHING: nothing was accepted, so no filename appears in a list row
    expect(screen.queryByText('ok.pdf')).not.toBeInTheDocument()
    expect(screen.queryByText('big.pdf')).not.toBeInTheDocument()
  })
})
```

Run it — it must fail (the page has no dropzone / session list yet):

```
npx jest src/__tests__/admin-upload-page.test.tsx
```

Expected: failures like `Unable to find a label 'Drop PDFs here or click to choose files'`.

### 1b. Implement

Rewrite `src/app/admin/upload/page.tsx`. Keep the existing intro copy (`:110-120`), the worker-health panel (`:122-157`), `WorkerHealth` interface, `STATUS_STYLES`, and `loadHealth`. Add the pieces below. This is the full file (Task 2 extends the polling effect + list render, marked with `// TASK 2` anchors — leave stubs now, fill them in Task 2):

```tsx
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Box, Heading, Text } from '@chakra-ui/react'

import { Tooltip } from '../components/Tooltip'
import { StatusChip } from '../components/StatusChip'
import { adminFetch } from '../lib/api'

interface WorkerHealth {
  queueDepth: number
  lastProcessedAt: string | null
  intakeBacklog: number
  status: 'idle' | 'processing' | 'pending' | 'stale'
}

// A file the user uploaded this session. In-memory only (gone on page leave,
// per the approved scope). Tracked until it reaches a terminal state.
interface UploadEntry {
  filename: string
  stem: string
  uploadedAt: number
  docId: string | null
  docStatus: string | null // null until a documents row with external_id === stem appears
  likelyDuplicate: boolean
}

const STATUS_STYLES: Record<
  WorkerHealth['status'],
  { color: string; label: string }
> = {
  idle: { color: '#0A6640', label: 'idle (caught up)' },
  processing: { color: '#0050C8', label: 'processing' },
  pending: { color: '#B7791F', label: 'pending — worker will pick up shortly' },
  stale: {
    color: '#C11101',
    label: 'NOT RUNNING — dropped files are NOT being processed',
  },
}

const POLL_INTERVAL_MS = 5000
const DUPLICATE_TIMEOUT_MS = 90000
const TERMINAL_DOC_STATUSES = new Set([
  'searchable',
  'needs_review',
  'error',
  'withdrawn',
])

// Strip ONLY a trailing ".pdf" (case-insensitive) — matches Python Path().stem
// and workerHealth.ts:87, so names like "a.b.pdf" → "a.b".
const stemOf = (filename: string) => filename.replace(/\.pdf$/i, '')

const isPdf = (f: File) => f.name.toLowerCase().endsWith('.pdf')

const isTerminal = (e: UploadEntry) =>
  e.likelyDuplicate ||
  (e.docStatus != null && TERMINAL_DOC_STATUSES.has(e.docStatus))

const UploadPage = () => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [health, setHealth] = useState<WorkerHealth | null>(null)
  const [entries, setEntries] = useState<UploadEntry[]>([])

  // Read entries inside the interval without re-arming it on every change.
  const entriesRef = useRef<UploadEntry[]>([])
  entriesRef.current = entries

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/worker-health')
      if (res.ok) {
        const body = await res.json()
        if (body.ok) setHealth(body.health)
      }
    } catch {
      // health is best-effort; don't block the page on it
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHealth()
  }, [loadHealth])

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        setError('Select at least one PDF file.')
        return
      }
      setBusy(true)
      setNotice(null)
      setError(null)
      try {
        const form = new FormData()
        for (const f of files) form.append('files', f)
        const res = await fetch('/api/admin/intake', { method: 'POST', body: form })
        if (res.status === 401) {
          window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
          return
        }
        const body = await res.json().catch(() => ({}))
        // Intake validation is ALL-OR-NOTHING: any bad file 400s the whole batch
        // with a single error string and no `uploaded` list. Surface the error
        // and leave the session list untouched — nothing was accepted.
        if (!res.ok || body.ok === false) {
          throw new Error(body.error || `HTTP ${res.status}`)
        }
        const uploaded = (body.uploaded as string[]) ?? []
        const now = Date.now()
        setEntries((prev) => [
          ...prev,
          ...uploaded.map((filename) => ({
            filename,
            stem: stemOf(filename),
            uploadedAt: now,
            docId: null,
            docStatus: null,
            likelyDuplicate: false,
          })),
        ])
        await loadHealth()
        if (inputRef.current) inputRef.current.value = ''
        setNotice(
          `${uploaded.length} file(s) dropped into the intake queue. Track each one below.`,
        )
      } catch (err: any) {
        setError(err.message)
      } finally {
        setBusy(false)
      }
    },
    [loadHealth],
  )

  const handlePick = () => uploadFiles(Array.from(inputRef.current?.files ?? []))

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const all = Array.from(e.dataTransfer.files)
    const pdfs = all.filter(isPdf)
    const rejected = all.filter((f) => !isPdf(f))
    if (rejected.length > 0) {
      setError(`Skipped non-PDF file(s): ${rejected.map((f) => f.name).join(', ')}`)
    }
    if (pdfs.length > 0) uploadFiles(pdfs)
  }

  // TASK 2: shared poll interval goes here.

  const statusStyle = health ? STATUS_STYLES[health.status] : null

  return (
    <Box>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Upload PDFs to intake{' '}
        <Tooltip help='Uploaded PDFs are placed in the S3 intake/ queue. The ingestion worker (a separate process) polls every ~10s, computes a content hash for dedup, registers a draft documents row, and drives the file through parse → language → summarize → classify → embed → publish. If the worker is not running, files sit in intake/ unprocessed — check the worker status panel below.'>
          How does upload work?
        </Tooltip>
      </Heading>
      <Text style={{ marginBottom: 16, color: '#555' }}>
        Select one or more PDF files. They will be placed in the intake queue
        and registered by the ingestion worker automatically.{' '}
        <strong>
          If a file is identical to a document already in the system, it is
          silently skipped as a duplicate
        </strong>{' '}
        — it will not appear in the catalog a second time. To re-process an
        existing document, use <strong>Re-ingest</strong> on its document page
        instead of uploading the file again.
      </Text>

      {/* Worker health panel — unchanged */}
      <Box
        style={{
          marginBottom: 16,
          padding: 12,
          border: '1px solid #ddd',
          borderRadius: 4,
          background: '#f7f7f7',
        }}
      >
        <Text style={{ fontWeight: 600, marginBottom: 4 }}>
          Ingestion worker: {health ? statusStyle!.label : 'checking…'}
        </Text>
        {health && (
          <Text style={{ fontSize: 13, color: '#666' }}>
            <Tooltip help='Documents currently queued or being processed by the pipeline.'>
              Queue depth
            </Tooltip>
            : {health.queueDepth} ·{' '}
            <Tooltip help='Uploaded files the worker has not registered yet. A non-zero backlog right after an upload is normal.'>
              Intake backlog
            </Tooltip>
            : {health.intakeBacklog}
            {health.lastProcessedAt &&
              ` · Last processed: ${new Date(health.lastProcessedAt).toLocaleString()}`}
          </Text>
        )}
        {health?.status === 'stale' && (
          <Text style={{ fontSize: 13, color: '#C11101', marginTop: 4 }}>
            Files have been dropped into intake but the worker is not processing
            them. Contact an administrator to start the worker (`cd
            search-service && ./venv/bin/python -m worker.main` locally, or
            check the ECS `ingestion-worker` service in production).
          </Text>
        )}
      </Box>

      {notice && (
        <Text style={{ color: '#0A6640', marginBottom: 12 }}>{notice}</Text>
      )}
      {error && (
        <Text style={{ color: '#C11101', marginBottom: 12 }}>{error}</Text>
      )}

      <div
        role='button'
        tabIndex={0}
        aria-label='Drop PDFs here or click to choose files'
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        style={{
          marginBottom: 12,
          padding: 32,
          border: `2px dashed ${dragOver ? '#0050C8' : '#bbb'}`,
          borderRadius: 6,
          background: dragOver ? '#eef4ff' : '#fafafa',
          textAlign: 'center',
          cursor: 'pointer',
          color: '#555',
        }}
      >
        {busy ? 'Uploading…' : 'Drop PDFs here or click to choose'}
        <input
          ref={inputRef}
          type='file'
          multiple
          accept='.pdf'
          aria-label='Choose PDF files'
          onChange={handlePick}
          style={{ display: 'none' }}
        />
      </div>

      {/* TASK 2: session-list render goes here. */}

      <Box style={{ marginTop: 16, fontSize: 13 }}>
        <Link href='/admin/review' style={{ textDecoration: 'underline' }}>
          Go to the Review queue →
        </Link>
      </Box>
    </Box>
  )
}

export default UploadPage
```

> Note: `StatusChip` and `adminFetch` are imported now but only used in Task 2. If lint complains about unused imports between tasks, add them in Task 2 instead — but since Task 1 and 2 land in the same session, importing now is fine.

### 1c. Verify + commit

```
npx jest src/__tests__/admin-upload-page.test.tsx
```
Expected: the two upload/reject/batch-400 tests pass (the polling tests don't exist yet).

```
npm run lint
```
Expected: no errors in the touched files.

```
npm run format:check
```
If it flags files, run `npm run format` and re-stage.

Commit:
```
git add src/app/admin/upload/page.tsx src/__tests__/admin-upload-page.test.tsx
git commit -m "feat(upload): drag-and-drop dropzone with per-file session list (batch-400 aware)"
```

---

## Task 2 — Session tracking list + shared poll + likely-duplicate inference

Add the single shared 5 s interval that resolves each entry's live status, the list render (filename + StatusChip + editor link, or "likely duplicate"), and the timeout-based duplicate inference.

### 2a. Write the failing test (introduces the fake-timers recipe)

Append to `src/__tests__/admin-upload-page.test.tsx`. **Fake-timers recipe** (no prior example in this repo): use `jest.useFakeTimers()` and advance with `jest.advanceTimersByTimeAsync`, always wrapped in `act`, so the interval fires AND its awaited fetches flush. Do the initial drop under real timers first (simpler), then switch — or fake from the start and advance to flush mount effects. The block below fakes from the start.

```tsx
describe('UploadPage — polling + likely-duplicate', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const dropOne = async (name: string) => {
    const zone = screen.getByLabelText('Drop PDFs here or click to choose files')
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [pdf(name)] } })
    })
  }

  it('flips an entry to its StatusChip + editor link when the doc registers', async () => {
    let registered = false
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/admin/worker-health') return Promise.resolve(healthOk)
      if (url === '/api/admin/intake')
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, uploaded: ['doc.pdf'] }),
        })
      // documents poll
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            items: registered
              ? [{ id: 'doc-id-1', externalId: 'doc', title: 'Doc', language: 'en', status: 'processing' }]
              : [],
            total: registered ? 1 : 0,
          }),
      })
    })
    global.fetch = fetchMock as any
    renderPage()
    await dropOne('doc.pdf')
    expect(screen.getByText('doc.pdf')).toBeInTheDocument()

    registered = true
    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS_TEST)
    })

    expect(screen.getByText('processing')).toBeInTheDocument() // StatusChip
    expect(screen.getByRole('link', { name: /open/i })).toHaveAttribute(
      'href',
      '/admin/documents/doc-id-1',
    )
  })

  it('does NOT exact-match on an ILIKE substring near-miss', async () => {
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/admin/worker-health') return Promise.resolve(healthOk)
      if (url === '/api/admin/intake')
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, uploaded: ['doc.pdf'] }),
        })
      // search=doc returns a substring near-miss "doc-2023", not our stem
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            items: [{ id: 'x', externalId: 'doc-2023', title: 'X', language: 'en', status: 'searchable' }],
          }),
      })
    })
    global.fetch = fetchMock as any
    renderPage()
    await dropOne('doc.pdf')
    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS_TEST)
    })
    expect(screen.queryByText('searchable')).not.toBeInTheDocument()
    expect(screen.getByText(/waiting to register/i)).toBeInTheDocument()
  })

  it('infers "likely duplicate" only after 90s with zero backlog', async () => {
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/admin/worker-health') return Promise.resolve(healthOk) // backlog 0
      if (url === '/api/admin/intake')
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, uploaded: ['dup.pdf'] }),
        })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, items: [] }) })
    })
    global.fetch = fetchMock as any
    renderPage()
    await dropOne('dup.pdf')

    // At 60s: not yet flagged.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60000)
    })
    expect(screen.queryByText(/likely duplicate/i)).not.toBeInTheDocument()

    // Past 90s: flagged, and polling stops (interval cleared).
    await act(async () => {
      await jest.advanceTimersByTimeAsync(40000)
    })
    expect(screen.getByText(/likely duplicate/i)).toBeInTheDocument()
  })
})
```

Export the interval constant so the test can reference it (or hard-code `5000`). Simplest: add near the top of the test file `const POLL_INTERVAL_MS_TEST = 5000`. Do NOT import the private constant; keep the test decoupled.

Run:
```
npx jest src/__tests__/admin-upload-page.test.tsx
```
Expected: the three new tests fail (no interval, no list render yet).

### 2b. Implement

Replace the `// TASK 2: shared poll interval goes here.` stub in `page.tsx` with:

```tsx
  // Single shared interval for the whole list. Re-arms only when the set of
  // non-terminal entries opens/closes (via `activePolling`), reading current
  // entries through entriesRef so ticks always see fresh state.
  const activePolling = entries.some((e) => !isTerminal(e))
  useEffect(() => {
    if (!activePolling) return
    const tick = async () => {
      const pending = entriesRef.current.filter((e) => !isTerminal(e))
      if (pending.length === 0) return

      // Fetch the (global, coarse) intake backlog once per tick. NOTE: this
      // signal is 0 when other users have no queued files; it is ALSO always 0
      // in INTAKE_LOCAL_DIR mode (no S3 bucket), so the duplicate inference can
      // over-fire in local dev — that's a known local-only artifact.
      let backlog: number | null = null
      try {
        const res = await fetch('/api/admin/worker-health')
        if (res.ok) {
          const body = await res.json()
          if (body.ok) backlog = body.health.intakeBacklog
        }
      } catch {
        // best-effort; leave backlog null (never triggers the duplicate inference)
      }

      const updates = new Map<string, Partial<UploadEntry>>()
      await Promise.all(
        pending.map(async (e) => {
          try {
            const body = await adminFetch<{
              items: { id: string; externalId: string; status: string }[]
            }>(`/api/admin/documents?search=${encodeURIComponent(e.stem)}&limit=5`)
            // `search` is an ILIKE substring match — exact-match the stem here.
            const match = body.items.find((it) => it.externalId === e.stem)
            if (match) {
              updates.set(e.stem, { docId: match.id, docStatus: match.status })
              return
            }
          } catch {
            // poll failure: leave the entry at its last known state
            return
          }
          // Not registered. Infer a likely (content-hash) duplicate only after
          // the timeout AND when the worker reports an empty intake queue.
          if (
            backlog === 0 &&
            Date.now() - e.uploadedAt > DUPLICATE_TIMEOUT_MS
          ) {
            updates.set(e.stem, { likelyDuplicate: true })
          }
        }),
      )

      if (updates.size > 0) {
        setEntries((prev) =>
          prev.map((e) => {
            const u = updates.get(e.stem)
            return u ? { ...e, ...u } : e
          }),
        )
      }
    }
    const id = setInterval(tick, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [activePolling])
```

Replace the `{/* TASK 2: session-list render goes here. */}` stub with:

```tsx
      {entries.length > 0 && (
        <Box style={{ marginTop: 24 }}>
          <Heading size='md' style={{ marginBottom: 8 }}>
            This session&rsquo;s uploads
          </Heading>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {entries.map((e) => (
              <li
                key={`${e.uploadedAt}-${e.filename}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 0',
                  borderBottom: '1px solid #eee',
                  fontSize: 14,
                }}
              >
                <span style={{ fontFamily: 'monospace', flex: 1 }}>
                  {e.filename}
                </span>
                {e.docStatus != null && e.docId != null ? (
                  <>
                    <StatusChip status={e.docStatus} />
                    <Link
                      href={`/admin/documents/${e.docId}`}
                      style={{ textDecoration: 'underline' }}
                    >
                      open →
                    </Link>
                  </>
                ) : e.likelyDuplicate ? (
                  <Tooltip help='Not registered after 90s and the intake queue is empty — the worker most likely skipped this file as a content-hash duplicate of a document already in the system. This is an inference (dedup-skip is not queryable per file). To re-process, use Re-ingest on the existing document.'>
                    <span style={{ color: '#B7791F', fontWeight: 600 }}>
                      likely duplicate
                    </span>
                  </Tooltip>
                ) : (
                  <span style={{ color: '#666' }}>
                    uploaded — waiting to register…
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Box>
      )}
```

### 2c. Verify + commit

```
npx jest src/__tests__/admin-upload-page.test.tsx
```
Expected: all tests pass (Task 1 + Task 2 = 6 tests green).

```
npm run lint
```
```
npm run format:check
```
(run `npm run format` if flagged, re-stage.)

Commit:
```
git add src/app/admin/upload/page.tsx src/__tests__/admin-upload-page.test.tsx
git commit -m "feat(upload): live per-file status polling with likely-duplicate inference"
```

---

## Task 3 — Verification sweep

No new code unless a check fails. Confirm the whole surface is consistent.

### 3a. Full test + typecheck + lint

```
npx jest src/__tests__/admin-upload-page.test.tsx
```
Expected: 6 passing.

```
npm test
```
Expected: whole Jest suite green (no regressions in other admin tests).

```
npx tsc --noEmit
```
Expected: no type errors. (Watch for: `UploadEntry` field access, the `adminFetch<T>` generic, `React.DragEvent` typing.)

```
npm run lint
```
Expected: clean.

```
npm run format:check
```
Expected: clean (or `npm run format` then re-verify).

### 3b. Manual smoke against the local stack (if running)

If the local stack is up (`./scripts/local-bootstrap.sh`, worker running):
```
npm run dev
```
Then in the browser at `/admin/upload`:
1. Drag 2–3 PDFs onto the zone → each appears in the list as "uploaded — waiting to register…".
2. Within a few polls each flips to a `draft`/`processing` StatusChip with an "open →" link to `/admin/documents/<id>`; links resolve.
3. Drop a `.txt` → "Skipped non-PDF file(s): …", nothing uploaded.
4. Re-drop an already-ingested identical PDF → after ~90 s it shows "likely duplicate" (remember: in `INTAKE_LOCAL_DIR` mode the backlog signal is always 0, so this fires reliably locally; in S3/prod it under-fires while other users have queued files — expected).

Confirm the worker-health panel and duplicate-skip intro copy are unchanged.

### 3c. Final commit (only if 3a/3b required a fix)

```
git add -A
git commit -m "test(upload): verification sweep for upload journey"
```

If nothing changed in Task 3, skip the commit.

---

## DRY / YAGNI guardrails

- `stemOf`, `isPdf`, `isTerminal`, `STATUS_STYLES`, `TERMINAL_DOC_STATUSES` are the only helpers — do not add more abstraction.
- Reuse `StatusChip`, `Tooltip`, `adminFetch` — do NOT re-implement status colors, tooltips, or fetch/401 handling.
- No dropzone library, no progress bars, no retry/cancel, no persistence, no `uploaded_by` — all explicit non-goals in the spec.
- One shared interval, never one-per-file.
- The intake POST stays raw `fetch` (multipart); everything else routes through `adminFetch`.
```
