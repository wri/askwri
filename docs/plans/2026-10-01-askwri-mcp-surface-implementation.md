# AskWRI MCP Search Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose one read-only search tool over MCP so a person in Claude Desktop, ChatGPT, or Cursor gets WRI passages with citations and working page links.

**Architecture:** A new stateless route, `src/app/api/mcp/route.ts`, mounted with `mcp-handler` (which serves both the current MCP spec and 2025-era Streamable HTTP clients). It checks one shared key, calls our existing `/api/llamaindex` route handler in-process to search, formats the results as readable text, and writes one audit row per call.

**Tech Stack:** Next.js 16 App Router (Node 24 in the image), TypeScript, Jest (jsdom default; `@jest-environment node` for route tests), `mcp-handler@^2`, `@modelcontextprotocol/server@^2`, `zod@^4`.

**Spec:** `docs/plans/2026-10-01-askwri-mcp-surface-design.md`

**Filed in `docs/plans/` rather than `docs/superpowers/plans/`** to match repo convention (the design doc this implements is filed there too).

## Global Constraints

- **One tool, read-only.** `search_wri` is the entire surface. Nothing in the response writes to AskWRI except the audit row in Task 4.
- **Results are readable text, not JSON.** Each result carries exactly: title, passage, page, link, relevance label, authors, year. Nothing else.
- **The relevance label comes from the retrieval system** (`relevance_tier`: `strong` / `partial` / `weak`). The raw `score` is never included — it is not stable across model changes.
- **Do not modify the website's `/api/llamaindex` contract.** Trim in the new code.
- **One shared key**, accepted either as an `Authorization: Bearer` credential or as a `key` parameter on the address.
- **No new infrastructure.** Same origin, no new server, certificate, or network rule.
- **Never push `main` or `production`.** All work lands on `qa` by PR (pushing qa auto-deploys QA).
- Repo conventions: API route → `initializeDatabase()` → a function in `src/db/queries/`. Prettier and eslint must be clean. Local production builds use `npx next build --webpack`.

## Review Focus

Failure modes the spec implies but no task's happy-path test exercises. Each line is pinned to a test in the task that owns the code.

1. **Several passages from the same document** — the reply must stay readable and not look like accidental duplicates.
2. **Missing authors and year** — must not print `undefined`, `null`, or `n/a` as if it were data.
3. **A passage with no page number** — the link must not carry `#page=undefined`.
4. **Search service down or erroring** — the caller must get a readable failure, not a protocol error and not an empty success.
5. **A question with zero results that is not flagged thin** — must not produce an empty or confusing reply.
6. **A result set at the ceiling** (`max_results: 20`) — the length ceiling is real, so the text cannot grow unbounded.

---

### Task 1: Dependencies and the result formatter

**Files:**
- Modify: `package.json` (dependencies)
- Create: `src/lib/mcp/search-results.ts`
- Test: `src/lib/__tests__/mcp-search-results.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `formatSearchResults(query: string, llamaIndexJson: unknown, baseUrl: string): string`, and the type `SearchResult` — used by Task 2.

- [ ] **Step 1: Install the three dependencies**

```bash
npm install mcp-handler@^2 @modelcontextprotocol/server@^2 zod@^4
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/__tests__/mcp-search-results.test.ts`:

```ts
/**
 * The text a person or their assistant receives. It carries exactly:
 * title, passage, page, link, relevance label, authors, year — and never
 * the website's plumbing (duplicate document list, raw metadata, raw score).
 */
import { formatSearchResults } from '../mcp/search-results'

function doc(over: Record<string, any> = {}) {
  return {
    doc_id: 'DOC-1234',
    title: 'Cities at the Crossroads',
    year: 2024,
    authors: ['A. Sharma', 'L. Chen'],
    relevance_tier: 'strong',
    score: 0.9137,
    kps: [{ snippet: 'Compact-growth policy shifted toward density bonuses.', page: 12 }],
    meta: { raw: { secret_internal_field: 'must not leak' } },
    ...over,
  }
}

function reply(docs: any[], over: Record<string, any> = {}) {
  return {
    ok: true,
    docs,
    sources: docs, // the website also returns the list again under this key
    debug: { sourcesCount: docs.length, internal_thing: 'must not leak' },
    usage: { calls: 3, total_usd: 0.004 },
    likely_off_topic: false,
    ...over,
  }
}

const BASE = 'https://askwri.example'

describe('formatSearchResults', () => {
  it('names the query and counts the passages', () => {
    const text = formatSearchResults('compact urban growth', reply([doc()]), BASE)
    expect(text).toContain('compact urban growth')
    expect(text).toContain('1 passage')
  })

  it('carries the title, passage, page, label, authors and year', () => {
    const text = formatSearchResults('q', reply([doc()]), BASE)
    expect(text).toContain('Cities at the Crossroads')
    expect(text).toContain('Compact-growth policy shifted toward density bonuses.')
    expect(text).toContain('A. Sharma, L. Chen')
    expect(text).toContain('2024')
    expect(text).toContain('[strong]')
  })

  it('builds an absolute link to the page', () => {
    const text = formatSearchResults('q', reply([doc()]), BASE)
    expect(text).toContain('https://askwri.example/api/pdf/DOC-1234.pdf#page=12')
  })

  it('leaks none of the website plumbing', () => {
    const text = formatSearchResults('q', reply([doc()]), BASE)
    expect(text).not.toContain('secret_internal_field')
    expect(text).not.toContain('internal_thing')
    expect(text).not.toContain('0.9137')
    expect(text).not.toContain('raw_score')
  })

  // Review Focus 3
  it('omits the page anchor when there is no page', () => {
    const text = formatSearchResults('q', reply([doc({ kps: [{ snippet: 's' }] })]), BASE)
    expect(text).toContain('https://askwri.example/api/pdf/DOC-1234.pdf')
    expect(text).not.toContain('#page=')
    expect(text).not.toContain('undefined')
  })

  // Review Focus 2
  it('omits authors and year rather than printing placeholders', () => {
    const text = formatSearchResults(
      'q',
      reply([doc({ authors: undefined, year: undefined })]),
      BASE,
    )
    expect(text).not.toMatch(/undefined|null|n\/a|NaN/)
  })

  // Review Focus 1
  it('keeps several passages from one document in ranked order', () => {
    const text = formatSearchResults(
      'q',
      reply([
        doc({ kps: [{ snippet: 'first passage', page: 3 }] }),
        doc({ kps: [{ snippet: 'second passage', page: 40 }], relevance_tier: 'partial' }),
      ]),
      BASE,
    )
    expect(text.indexOf('first passage')).toBeLessThan(text.indexOf('second passage'))
    expect(text).toContain('[partial]')
  })

  it('opens with the thin-corpus note when the search says so', () => {
    const text = formatSearchResults(
      'q',
      reply([doc()], { likely_off_topic: true }),
      BASE,
    )
    expect(text.startsWith('The core topic')).toBe(true)
    expect(text).toContain('tangential')
  })

  // Review Focus 5
  it('says plainly when nothing matched', () => {
    const text = formatSearchResults('q', reply([]), BASE)
    expect(text).toContain('No passages')
  })

  // Review Focus 5, continued
  it('asks the search service to return nothing when it fails', () => {
    const text = formatSearchResults('q', { ok: false, error: 'boom' }, BASE)
    expect(text).toContain('could not be reached')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/lib/__tests__/mcp-search-results.test.ts`
Expected: FAIL — `Cannot find module '../mcp/search-results'`

- [ ] **Step 4: Implement `formatSearchResults` in `src/lib/mcp/search-results.ts`**

Shape of the output is fixed by the spec (§2). One block per result, ranked order preserved, no re-sorting. The relevance label is read from `relevance_tier`; if it is missing, print no label rather than an invented one. Read the snippet and page from `kps[0]` (that is where the existing route puts the cited passage and page — `src/app/api/llamaindex/route.ts:167-236`). Build the link as `${baseUrl}/api/pdf/${doc_id}.pdf`, appending `#page=N` only when a page exists.

Handle, in order: a failed reply (`ok === false`) → a sentence saying the search service could not be reached; `likely_off_topic === true` → the thin-corpus note first, then the passages; zero results → a plain "No passages" sentence.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/lib/__tests__/mcp-search-results.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/mcp/search-results.ts src/lib/__tests__/mcp-search-results.test.ts
git commit -m "feat(mcp): readable text formatter for search results"
```

---

### Task 2: The search tool

**Files:**
- Create: `src/lib/mcp/search-tool.ts`
- Test: `src/lib/__tests__/mcp-search-tool.test.ts`

**Interfaces:**
- Consumes: `formatSearchResults(query, llamaIndexJson, baseUrl)` from Task 1.
- Produces: `SEARCH_TOOL_NAME` (the string `'search_wri'`), `SEARCH_TOOL_DESCRIPTION`, `searchToolInputSchema`, and `runSearchWri(args: SearchArgs, ctx: { baseUrl: string }): Promise<string>` — used by Task 3.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/mcp-search-tool.test.ts`:

```ts
/**
 * @jest-environment node
 *
 * The tool calls our own /api/llamaindex route handler in-process: no loopback
 * hop through the load balancer, no origin configuration. The search service is
 * the only network boundary, so that is what gets mocked.
 */
import { NextRequest } from 'next/server'

const ENV = { ...process.env }
let fetchMock: jest.SpyInstance

function serviceReply(docs: any[] = []) {
  return new Response(JSON.stringify({ docs, total_results: docs.length, query: 'q', mode: 'cite', debug: {} }), {
    status: 200,
  })
}

const DOC = {
  doc_id: 'DOC-1234',
  title: 'Cities at the Crossroads',
  content: 'window text **[the cited passage]** more window text',
  score: 0.9,
  page: 12,
  metadata: { relevance_tier: 'strong', authors: 'A. Sharma;L. Chen', year: 2024, chunk_id: 'c1' },
}

beforeEach(() => {
  jest.resetModules()
  process.env = { ...ENV, SEARCH_SERVICE_URL: 'http://search.test' }
  fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(serviceReply([DOC]))
})
afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ENV }
})

function forwarded(): any {
  return JSON.parse(fetchMock.mock.calls[0][1].body)
}

describe('runSearchWri', () => {
  it('returns the formatted text', async () => {
    const { runSearchWri } = await import('../mcp/search-tool')
    const text = await runSearchWri({ query: 'compact urban growth' }, { baseUrl: 'https://askwri.example' })
    expect(text).toContain('Cities at the Crossroads')
    expect(text).toContain('https://askwri.example/api/pdf/DOC-1234.pdf#page=12')
  })

  it('passes the year limits through as min_year and max_year', async () => {
    const { runSearchWri } = await import('../mcp/search-tool')
    await runSearchWri({ query: 'q', year_from: 2019, year_to: 2026 }, { baseUrl: 'https://x' })
    expect(forwarded()).toMatchObject({ min_year: 2019, max_year: 2026 })
  })

  it('defaults to ten results and caps at twenty', async () => {
    const { runSearchWri, DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS } = await import('../mcp/search-tool')
    expect(DEFAULT_MAX_RESULTS).toBe(10)
    expect(MAX_MAX_RESULTS).toBe(20)
    await runSearchWri({ query: 'q' }, { baseUrl: 'https://x' })
    expect(forwarded().max_results).toBe(10)
  })

  // Review Focus 6
  it('clamps an oversized request to the ceiling', async () => {
    const { runSearchWri } = await import('../mcp/search-tool')
    await runSearchWri({ query: 'q', max_results: 500 }, { baseUrl: 'https://x' })
    expect(forwarded().max_results).toBe(20)
  })

  // Review Focus 4
  it('returns a readable sentence rather than throwing when the service fails', async () => {
    fetchMock.mockResolvedValue(new Response('kaboom', { status: 500 }))
    const { runSearchWri } = await import('../mcp/search-tool')
    const text = await runSearchWri({ query: 'q' }, { baseUrl: 'https://x' })
    expect(text).toContain('could not be reached')
  })
})
```

Correct the four test cases above as written — they are the assertions the implementation must satisfy, not a sketch.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/lib/__tests__/mcp-search-tool.test.ts`
Expected: FAIL — `Cannot find module '../mcp/search-tool'`

- [ ] **Step 3: Implement `src/lib/mcp/search-tool.ts`**

Exports:

- `SEARCH_TOOL_NAME = 'search_wri'`.
- `DEFAULT_MAX_RESULTS = 10`, `MAX_MAX_RESULTS = 20`.
- `SEARCH_TOOL_DESCRIPTION` — exact copy, because it is the only lever we have on whether citations survive (spec §10.1):

```
Search WRI's published research corpus. Returns passages from WRI reports and
publications, each with a relevance label and a link that opens the page it came
from. Use it for any question about what WRI has published. The label is strong,
partial, or weak: strong means the passage directly addresses the question, weak
means it is tangential. When you use a passage in an answer, always name the
document and give the page link. When the results say the corpus is thin on the
topic, say so rather than answering as if it were well covered.
```

- `searchToolInputSchema` — a zod object: `query` (string, min 1), `year_from` / `year_to` (optional ints, 1900–2100, described as "only if the person named a year range"), `max_results` (optional int, 1 to 20).
- `runSearchWri(args, ctx)` — imports `POST` from `@/app/api/llamaindex/route` (a plain function export; the repo's own route tests call it this way), builds a `NextRequest` for an internal URL like `http://internal/api/llamaindex` with body `{ query, mode: 'cite', max_results, min_year?, max_year? }`, calls it, parses the JSON, and returns `formatSearchResults(query, json, ctx.baseUrl)`. It never throws: any thrown error becomes the same readable "could not be reached" text.

`mode: 'cite'` is required — the answer preset fetches far more documents than anyone needs here.

Clamp `max_results` to `MAX_MAX_RESULTS` before forwarding; never let a caller's number decide how much text we generate.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/lib/__tests__/mcp-search-tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/search-tool.ts src/lib/__tests__/mcp-search-tool.test.ts
git commit -m "feat(mcp): search_wri tool — schema, description, in-process search call"
```

---

### Task 3: The MCP route and the shared key

**Files:**
- Create: `src/app/api/mcp/route.ts`
- Test: `src/__tests__/mcp-route.test.ts`

**Interfaces:**
- Consumes: `SEARCH_TOOL_NAME`, `SEARCH_TOOL_DESCRIPTION`, `searchToolInputSchema`, `runSearchWri` from Task 2.
- Produces: `export { handler as GET, handler as POST }` from the route module, and an exported `isAuthorized(req: Request): boolean` so the key rule is testable on its own.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/mcp-route.test.ts`:

```ts
/**
 * @jest-environment node
 *
 * The shared key is the only gate. Both ways of presenting it are accepted
 * because some assistants let you set a credential and some only let you paste
 * an address. A wrong key gets a readable refusal so a person can tell "key is
 * wrong" from "service is down".
 */
import { NextRequest } from 'next/server'

const ENV = { ...process.env }
const KEY = 'test-shared-key'

function rpc(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
}

const CALL = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'search_wri', arguments: { query: 'compact urban growth' } },
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/mcp/route')
  return POST(rpc(body, headers))
}

beforeEach(() => {
  jest.resetModules()
  process.env = { ...ENV, MCP_SHARED_KEY: KEY, SEARCH_SERVICE_URL: 'http://search.test' }
  jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        docs: [
          {
            doc_id: 'DOC-1234',
            title: 'Cities at the Crossroads',
            content: '**[the cited passage]**',
            score: 0.9,
            page: 12,
            metadata: { relevance_tier: 'strong', authors: 'A. Sharma', year: 2024 },
          },
        ],
        total_results: 1,
        query: 'q',
        mode: 'cite',
        debug: {},
      }),
      { status: 200 },
    ),
  )
})
afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ENV }
})

describe('GET /api/mcp', () => {
  it('is mounted', async () => {
    const mod = await import('@/app/api/mcp/route')
    expect(typeof mod.GET).toBe('function')
  })
})

describe('the shared key', () => {
  it('refuses a request with no key', async () => {
    const res = await post(INIT)
    expect(res.status).toBe(401)
    expect(await res.text()).toContain('key')
  })

  it('refuses a wrong key', async () => {
    const res = await post(INIT, { authorization: 'Bearer nope' })
    expect(res.status).toBe(401)
  })

  it('accepts the key as a credential', async () => {
    const res = await post(INIT, { authorization: `Bearer ${KEY}` })
    expect(res.status).toBe(200)
  })

  it('accepts the key as an address parameter', async () => {
    const { POST } = await import('@/app/api/mcp/route')
    const req = new NextRequest(`http://localhost/api/mcp?key=${KEY}`, {
      method: 'POST',
      body: JSON.stringify(INIT),
      headers: { 'content-type': 'application/json' },
    })
    expect((await POST(req)).status).toBe(200)
  })
})

describe('tools/call', () => {
  it('returns the passages as text', async () => {
    await post(INIT, { authorization: `Bearer ${KEY}` })
    const res = await post(CALL, { authorization: `Bearer ${KEY}` })
    expect(res.status).toBe(200)
    const body = await res.text()
    // Works whether the handler answers with JSON or an event stream.
    expect(body).toContain('Cities at the Crossroads')
    expect(body).toContain('/api/pdf/DOC-1234.pdf#page=12')
  })

  it('lists exactly one tool', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { authorization: `Bearer ${KEY}` },
    )
    const body = await res.text()
    expect(body).toContain('search_wri')
    expect(body.match(/"inputSchema"/g)?.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/__tests__/mcp-route.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/mcp/route'`

- [ ] **Step 3: Implement `src/app/api/mcp/route.ts`**

Structure:

1. `isAuthorized(req)` — true when `Authorization: Bearer <key>` matches `process.env.MCP_SHARED_KEY`, or when the `key` search parameter matches it. If `MCP_SHARED_KEY` is unset, return `false` for everything (an unset key must not mean an open door).
2. If not authorized, return `401` with a readable plain-text body naming the key. Do this *before* building the MCP handler.
3. Build the handler with `createMcpHandler`:

```ts
const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      SEARCH_TOOL_NAME,
      { title: 'Search the WRI corpus', description: SEARCH_TOOL_DESCRIPTION, inputSchema: searchToolInputSchema },
      async (args) => ({
        content: [{ type: 'text', text: await runSearchWri(args, { baseUrl: new URL(req.url).origin }) }],
      }),
    )
  },
  { serverInfo: { name: 'askwri', version: '1.0.0' } },
)
```

The `baseUrl` for citations must come from the incoming request's own origin, not a constant — that is how the link matches whichever address the person actually connected to.

4. `export { handler as GET, handler as POST }` (the package's documented Next.js mounting, `mcp-handler` README).
5. `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'`.

If `createMcpHandler` in this version needs a different options shape, read `node_modules/mcp-handler/README.md` — the 2.x options object is `createMcpHandler(initialize, { serverInfo, verboseLogs, ... })`, and the variadic `server.tool(...)` form used in 1.x is gone.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/__tests__/mcp-route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/mcp/route.ts src/__tests__/mcp-route.test.ts
git commit -m "feat(mcp): /api/mcp route with shared-key gate and one read-only tool"
```

---

### Task 4: The call log

**Files:**
- Create: `src/db/queries/logAgentSearch.ts`
- Modify: `src/db/queries/audit.ts` (the `AuditAction` union)
- Modify: `src/app/api/mcp/route.ts` (call it)
- Test: `src/__tests__/mcp-route-logging.test.ts`

**Interfaces:**
- Consumes: the route from Task 3.
- Produces: `logAgentSearch(entry: AgentSearchEntry): Promise<void>` where `AgentSearchEntry` is `{ query: string; resultCount: number; thin: boolean; costUsd: number | null; durationMs: number }`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/mcp-route-logging.test.ts`:

```ts
/**
 * @jest-environment node
 *
 * One row per call into the existing audit_log, which has a nullable "who" and
 * so needs no identity. Logging is best-effort: a logging failure must never
 * lose the person's search result.
 */
import { NextRequest } from 'next/server'

const ENV = { ...process.env }
const KEY = 'test-shared-key'
let logMock: jest.Mock

jest.mock('@/db/queries/logAgentSearch', () => ({
  logAgentSearch: (...args: unknown[]) => logMock(...args),
}))

function req(body: unknown) {
  return new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  })
}

const CALL = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'search_wri', arguments: { query: 'compact urban growth' } },
}

beforeEach(() => {
  jest.resetModules()
  logMock = jest.fn().mockResolvedValue(undefined)
  process.env = { ...ENV, MCP_SHARED_KEY: KEY, SEARCH_SERVICE_URL: 'http://search.test' }
  jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({ docs: [], total_results: 0, query: 'q', mode: 'cite', debug: {}, usage: { total_usd: 0.002 } }),
      { status: 200 },
    ),
  )
})
afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ENV }
})

describe('call logging', () => {
  it('records the question, the count and the cost', async () => {
    const { POST } = await import('@/app/api/mcp/route')
    await POST(req(CALL))
    expect(logMock).toHaveBeenCalledTimes(1)
    expect(logMock.mock.calls[0][0]).toMatchObject({
      query: 'compact urban growth',
      resultCount: 0,
      costUsd: 0.002,
    })
  })

  it('still returns the result when logging fails', async () => {
    logMock.mockRejectedValue(new Error('db down'))
    const { POST } = await import('@/app/api/mcp/route')
    const res = await POST(req(CALL))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('No passages')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/__tests__/mcp-route-logging.test.ts`
Expected: FAIL — `Cannot find module '@/db/queries/logAgentSearch'`

- [ ] **Step 3: Add the action value**

In `src/db/queries/audit.ts`, add `'agent_search'` to the `AuditAction` union.

- [ ] **Step 4: Implement `logAgentSearch`**

`src/db/queries/logAgentSearch.ts` follows the repo's query pattern: `AppDataSource.query(...)` or `writeAudit(...)` — reuse `writeAudit` with `{ actorUserId: null, source: 'system', action: 'agent_search', entityType: 'agent_call', entityId: null, after: { query, resultCount, thin, costUsd, durationMs } }`. Reusing `writeAudit` is preferred: one insert path, one place the shape is defined.

- [ ] **Step 5: Call it from the route**

In the tool handler, time the call, and after the text is produced call `logAgentSearch(...)` inside a `try/catch` that swallows the error and logs to the console. Await it before returning so the row is written for short-lived requests — but never let it change the response.

`costUsd` comes from the search reply's `usage.total_usd` when present, otherwise `null`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/__tests__/mcp-route-logging.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/db/queries/logAgentSearch.ts src/db/queries/audit.ts src/app/api/mcp/route.ts src/__tests__/mcp-route-logging.test.ts
git commit -m "feat(mcp): log one audit row per call — the question loop, for free"
```

---

### Task 5: Documentation, and the key in the environment

**Files:**
- Modify: `.env.example`
- Create: `docs/runbooks/askwri-mcp-connector.md`
- Modify: `CLAUDE.md` (env vars section — one line)

**Interfaces:**
- Consumes: the env var name `MCP_SHARED_KEY` from Task 3.
- Produces: nothing other tasks import.

- [ ] **Step 1: Add the env var to `.env.example`**

Next to `ADMIN_API_TOKEN`, with a comment saying it is the shared key for the MCP search surface, and that leaving it empty closes that surface entirely.

- [ ] **Step 2: Write the connection runbook**

`docs/runbooks/askwri-mcp-connector.md`, covering: the address (`https://<origin>/api/mcp`), the key and its two forms, the wrong-key message, that QA and production have separate keys, what to expect when results are thin, and how to test with a tool that only installs locally — `npx -y mcp-remote <address>` (third-party bridge; we do not build one, per spec §6). Also note the standing cost of a single shared key: rotating it breaks every connected tool until each pastes the new one.

- [ ] **Step 3: One line in `CLAUDE.md`**

Add `MCP_SHARED_KEY` to the env vars section with the same one-line description.

- [ ] **Step 4: Verify formatting and lint**

Run: `npm run lint && npx prettier --check .env.example docs/runbooks/askwri-mcp-connector.md CLAUDE.md`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add .env.example docs/runbooks/askwri-mcp-connector.md CLAUDE.md
git commit -m "docs(mcp): how to connect, and the key that gates it"
```

- [ ] **Step 6: Ops step — hand this to the operator, do not do it yourself**

The key reaches the deployed app through the GitHub Secret `ASKWRI_APP_ENV`, a JSON blob that terraform renders into the app container's environment (`terraform/infrastructure/ecs.tf:433`, `.github/workflows/deploy-qa.yml:197`). Adding `MCP_SHARED_KEY` to that JSON and redeploying QA is an operator action. No terraform change is needed. Record in the PR that QA will have this surface closed until the key is added.

---

### Task 6: Prove it by hand

**Files:**
- Create: `docs/plans/2026-10-01-mcp-hand-check.md`

**Interfaces:**
- Consumes: a deployed QA with the key set, and a real assistant.
- Produces: the evidence the design's proof section asks for.

- [ ] **Step 1: Run the whole suite and the build**

Run: `npm test && npm run lint && npx next build --webpack`
Expected: all green. The build is the deploy gate; a type error here stops the QA deploy.

- [ ] **Step 2: Connect a real assistant**

Add the QA address as a custom connector with the key, in Claude Desktop (or ChatGPT, or Cursor). Confirm the tool is listed as `search_wri` and that a wrong key is refused with a readable message.

- [ ] **Step 3: Ask the three questions**

1. One the corpus answers well — e.g. a topic from the cite golden set.
2. One it answers thinly — a narrow or half-covered topic.
3. One it does not cover at all — something clearly outside the corpus.

For each: did the assistant get a useful, understandable reply, and did every link open the right document at the right page? The page jump relies on the browser's PDF viewer, so check in two browsers before calling it working.

- [ ] **Step 4: Record the evidence**

Write `docs/plans/2026-10-01-mcp-hand-check.md`: the three questions, the raw text the tool returned for each, the link-resolution result, and anything that read badly. This is the record that decides whether the surface was worth building — including if the answer is no.

- [ ] **Step 5: Commit**

```bash
git add docs/plans/2026-10-01-mcp-hand-check.md
git commit -m "docs(mcp): hand-check evidence — three questions against a real assistant"
```

---

## Self-Review Notes

- **Spec coverage:** §2 the surface → Tasks 1–3; §3 (facts) → used as the ground truth for field names; §4 where the code goes → Task 3; §5 the key → Task 3 plus Task 5's ops note; §6 connecting → Task 5; §7 logging → Task 4; §8 proof → Tasks 1–4 tests plus Task 6; §9 open questions → settled in the plan (default 10 / ceiling 20, year limits exposed, description copy in Task 2); §10 not-built list → respected, nothing in the plan builds them.
- **Types:** `formatSearchResults(query, llamaIndexJson, baseUrl)` in Task 1 == Task 2's call site; `SEARCH_TOOL_NAME` / `searchToolInputSchema` / `runSearchWri` names match between Tasks 2 and 3; `logAgentSearch(entry)` shape matches between Tasks 3 and 4.
- **Two deliberate deferrals inside the plan:** rate limiting (spec §9.1) is *not* in this plan — the audit rows in Task 4 give the cost signal, and a cap goes in when that shows abuse. The QA-open-or-internal question (spec §9.5) resolves to internal until the key is set, which Task 5 records.
