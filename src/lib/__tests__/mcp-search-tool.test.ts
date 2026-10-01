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
  return new Response(
    JSON.stringify({
      docs,
      total_results: docs.length,
      query: 'q',
      mode: 'cite',
      debug: {},
    }),
    { status: 200 },
  )
}

const DOC = {
  doc_id: 'DOC-1234',
  title: 'Cities at the Crossroads',
  content: 'window text **[the cited passage]** more window text',
  score: 0.9,
  page: 12,
  metadata: {
    relevance_tier: 'strong',
    authors: 'A. Sharma;L. Chen',
    year: 2024,
    chunk_id: 'c1',
  },
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
  // Premise check A10, and the most falsifiable claim in this plan: a Next.js route
  // module can be imported and called from another server module. If this fails, stop
  // and report — do not paper over it here. The fallback is in Step 3.
  it('can call the existing route handler in-process', async () => {
    const { POST } = await import('@/app/api/llamaindex/route')
    const res = await POST(
      new NextRequest('http://internal/api/llamaindex', {
        method: 'POST',
        body: JSON.stringify({ query: 'q', mode: 'cite' }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(res.status).toBe(200)
  })

  it('returns the formatted text', async () => {
    const { runSearchWri } = await import('../mcp/search-tool')
    const text = await runSearchWri(
      { query: 'compact urban growth' },
      { baseUrl: 'https://askwri.example' },
    )
    expect(text).toContain('Cities at the Crossroads')
    expect(text).toContain(
      'https://askwri.example/api/pdf/DOC-1234.pdf#page=12',
    )
  })

  it('passes the year limits through as min_year and max_year', async () => {
    const { runSearchWri } = await import('../mcp/search-tool')
    await runSearchWri(
      { query: 'q', year_from: 2019, year_to: 2026 },
      { baseUrl: 'https://x' },
    )
    expect(forwarded()).toMatchObject({ min_year: 2019, max_year: 2026 })
  })

  it('defaults to ten results and caps at twenty', async () => {
    const { runSearchWri, DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS } = await import(
      '../mcp/search-tool'
    )
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
