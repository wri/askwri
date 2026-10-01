/**
 * @jest-environment node
 *
 * The route serves one read-only tool over the standard.
 *
 * No shared-key check in this run: the operator asked for the first three steps
 * only, and the key is the later half of that step. This route is therefore
 * ungated until the key lands — it must not be deployed publicly before then.
 */
import { NextRequest } from 'next/server'

const ENV = { ...process.env }

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

function rpc(body: unknown) {
  return new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      // A real MCP client sends both: the server may answer with an event stream.
      accept: 'application/json, text/event-stream',
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

async function post(body: unknown) {
  const { POST } = await import('@/app/api/mcp/route')
  return POST(rpc(body))
}

beforeEach(() => {
  jest.resetModules()
  process.env = { ...ENV, SEARCH_SERVICE_URL: 'http://search.test' }
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

describe('tools/call', () => {
  it('returns the passages as text', async () => {
    await post(INIT)
    const res = await post(CALL)
    expect(res.status).toBe(200)
    const body = await res.text()
    // Works whether the handler answers with JSON or an event stream.
    expect(body).toContain('Cities at the Crossroads')
    expect(body).toContain('/api/pdf/DOC-1234.pdf#page=12')
  })

  it('lists exactly one tool', async () => {
    const res = await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: {},
    })
    const body = await res.text()
    expect(body).toContain('search_wri')
    expect(body.match(/"inputSchema"/g)?.length).toBe(1)
  })
})
