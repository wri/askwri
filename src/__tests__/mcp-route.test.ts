/**
 * @jest-environment node
 *
 * The route serves one read-only tool over the standard, behind one shared key.
 */
import { NextRequest } from 'next/server'

const ENV = { ...process.env }
const KEY = 'test-shared-key'

const DOC = {
  doc_id: 'DOC-1234',
  title: 'Cities at the Crossroads',
  content: '**[the cited passage]**',
  score: 0.9,
  page: 12,
  metadata: {
    relevance_tier: 'strong',
    authors: 'A. Sharma',
    year: 2024,
  },
}

function serviceReply() {
  return new Response(
    JSON.stringify({
      docs: [DOC],
      total_results: 1,
      query: 'q',
      mode: 'cite',
      debug: {},
    }),
    { status: 200 },
  )
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      // A real MCP client sends both: the server may answer with an event stream.
      accept: 'application/json, text/event-stream',
      ...headers,
    },
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
  return POST(request(body, headers))
}

/** The key as part of the address, which is the only form some tools can use. */
async function postWithKeyInUrl(body: unknown) {
  const { POST } = await import('@/app/api/mcp/route')
  return POST(
    new NextRequest(`http://localhost/api/mcp?key=${KEY}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
    }),
  )
}

const AUTH = { authorization: `Bearer ${KEY}` }

beforeEach(() => {
  jest.resetModules()
  process.env = {
    ...ENV,
    MCP_SHARED_KEY: KEY,
    SEARCH_SERVICE_URL: 'http://search.test',
  }
  jest.spyOn(global, 'fetch').mockResolvedValue(serviceReply())
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
    const res = await post(INIT, AUTH)
    expect(res.status).toBe(200)
  })

  it('accepts the key as part of the address', async () => {
    const res = await postWithKeyInUrl(INIT)
    expect(res.status).toBe(200)
  })

  // A base64 key contains '+' and '/'. '+' must survive the address form: the
  // usual query-parameter reader turns it into a space, which fails auth in a
  // way that looks like a wrong key rather than an encoding problem.
  it('accepts a key containing plus and slash in the address', async () => {
    const awkward = 'a+b/c=d'
    process.env = { ...process.env, MCP_SHARED_KEY: awkward }
    jest.resetModules()
    const { POST } = await import('@/app/api/mcp/route')
    // Both the encoded form and a raw paste, because an operator pasting the key
    // into an address by hand sends the raw characters.
    for (const inUrl of [encodeURIComponent(awkward), awkward]) {
      const res = await POST(
        new NextRequest(`http://localhost/api/mcp?key=${inUrl}`, {
          method: 'POST',
          body: JSON.stringify(INIT),
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
        }),
      )
      expect(res.status).toBe(200)
    }
  })

  it('records a refusal, so probing is visible', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    await post(INIT, { authorization: 'Bearer nope' })
    expect(warn).toHaveBeenCalled()
    // The value presented is never written down.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('nope')
  })

  it('refuses everything when no key is configured at all', async () => {
    delete process.env.MCP_SHARED_KEY
    jest.resetModules()
    const res = await post(INIT)
    expect(res.status).toBe(401)
  })
})

describe('tools/call', () => {
  it('returns the passages as text', async () => {
    await post(INIT, AUTH)
    const res = await post(CALL, AUTH)
    expect(res.status).toBe(200)
    const body = await res.text()
    // Works whether the handler answers with JSON or an event stream.
    expect(body).toContain('Cities at the Crossroads')
    expect(body).toContain('/api/pdf/DOC-1234.pdf#page=12')
  })

  it('lists exactly one tool', async () => {
    // A real client initialises first; do the same so a stricter handler version
    // cannot make this test pass by accident.
    await post(INIT, AUTH)
    const res = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      AUTH,
    )
    const body = await res.text()
    expect(body).toContain('search_wri')
    expect(body.match(/"inputSchema"/g)?.length).toBe(1)
  })

  // CVE-2026-111768: one request inside the body limit must not grow the tool
  // payload without bound. The SDK counts array elements and object keys in
  // `arguments`, but only when `maxToolInputElements` is set — and `mcp-handler`
  // forwards it to `new McpServer(...)` through an options spread without naming
  // it in its own types. So this asserts the boundary, in both directions: a
  // call under the limit still reaches the search service, one over it is
  // refused before the tool runs. Without the "under" half this would pass on
  // any rejection at all, including a typo that never reaches the SDK.
  it('refuses arguments over the element limit and still runs under it', async () => {
    await post(INIT, AUTH)
    const call = (id: number, elements: number) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'search_wri',
        arguments: {
          query: 'compact urban growth',
          filler: Array.from({ length: elements }, (_, i) => i),
        },
      },
    })

    const under = await post(call(4, 900), AUTH)
    expect(await under.text()).toContain('Cities at the Crossroads')
    // Exactly one: a stale call count from an earlier case must not be able to
    // satisfy this.
    expect(global.fetch).toHaveBeenCalledTimes(1)

    ;(global.fetch as jest.Mock).mockClear()
    const over = await post(call(5, 1001), AUTH)
    const overBody = await over.text()
    // The SDK's own words, so this cannot pass on some other failure.
    expect(overBody).toContain(
      'arguments contain more than the maximum of 1000 elements',
    )
    expect(overBody).toContain('"isError":true')
    // The refusal happens while parsing, so nothing was searched.
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
