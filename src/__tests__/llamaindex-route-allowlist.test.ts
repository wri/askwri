/**
 * @jest-environment node
 *
 * The gateway used to spread the whole request body onto the search-service
 * call, so any stray field could override the mode preset. Now only known
 * QueryRequest fields are forwarded; anything else is a 400.
 */
import { NextRequest } from 'next/server'

const ENV = { ...process.env }
let fetchMock: jest.SpyInstance

function serviceReply() {
  return new Response(
    JSON.stringify({
      docs: [],
      total_results: 0,
      query: 'q',
      mode: 'answer',
      debug: {},
    }),
    { status: 200 },
  )
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/llamaindex/route')
  const res = await POST(
    new NextRequest('http://localhost/api/llamaindex', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  )
  return { status: res.status, json: await res.json() }
}

function forwarded(): any {
  return JSON.parse(fetchMock.mock.calls[0][1].body)
}

beforeEach(() => {
  jest.resetModules()
  process.env = { ...ENV, SEARCH_SERVICE_URL: 'http://search.test' }
  fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(serviceReply())
})
afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ENV }
})

describe('POST /api/llamaindex allowlist', () => {
  it('forwards the answer preset with no extra fields', async () => {
    const { status } = await post({ query: 'q', mode: 'answer' })
    expect(status).toBe(200)
    expect(forwarded()).toMatchObject({
      query: 'q',
      mode: 'answer',
      max_results: 15,
      rerank: true,
      similarity_threshold: 0.0,
      include_metadata: true,
    })
  })

  it('forwards eval knobs that are QueryRequest fields', async () => {
    await post({
      query: 'q',
      mode: 'answer',
      expansion_lane_weight: 0.5,
      expansion: false,
      max_results: 30,
      cite_doc_ids: ['a'],
    })
    expect(forwarded()).toMatchObject({
      expansion_lane_weight: 0.5,
      expansion: false,
      max_results: 30,
      cite_doc_ids: ['a'],
    })
  })

  it('keeps forwarding every field the cite results page sends today', async () => {
    await post({
      query: 'q',
      mode: 'cite',
      max_results: 40,
      similarity_threshold: 0.0,
      include_metadata: true,
      rerank: true,
      facets: [{ facet: 'geography', value: 'Brazil' }],
      expansion: true,
    })
    expect(forwarded()).toMatchObject({
      max_results: 40,
      facets: [{ facet: 'geography', value: 'Brazil' }],
    })
  })

  it('still maps the legacy camelCase overrides', async () => {
    await post({ query: 'q', mode: 'answer', alpha: 0.8, rerankTopK: 5 })
    expect(forwarded()).toMatchObject({ dense_weight: 0.8, rerank_top_n: 5 })
    // Float-safe per controller ruling: 1 - 0.8 === 0.19999999999999996 in JS,
    // so toMatchObject's strict equality can't assert sparse_weight: 0.2.
    expect(forwarded().sparse_weight).toBeCloseTo(0.2, 10)
  })

  it('rejects unknown fields with 400 and does not call the service', async () => {
    const { status, json } = await post({
      query: 'q',
      mode: 'answer',
      rerank_candidates: 5,
      foo: 1,
    })
    expect(status).toBe(400)
    expect(json.ok).toBe(false)
    expect(json.error).toContain('rerank_candidates')
    expect(json.error).toContain('foo')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
