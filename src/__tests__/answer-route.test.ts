/**
 * @jest-environment node
 *
 * Contract tests for POST /api/answer. The provider is a mocked global fetch
 * so every test asserts on exactly what would have been sent to the model.
 */
import { NextRequest } from 'next/server'

const ENV = { ...process.env }
let fetchMock: jest.SpyInstance

function modelReply(content: string, status = 200) {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content } }],
    }),
    { status },
  )
}

function docs(n: number, snippetLen = 1000) {
  return Array.from({ length: n }, (_, i) => ({
    doc_id: `doc_${i + 1}`,
    title: `Title ${i + 1}`,
    year: 2020 + i,
    kps: [
      {
        kp_relevance: 1 - i * 0.01,
        snippet: `S${i + 1} `.repeat(snippetLen / 3).slice(0, snippetLen),
        page: i + 1,
        passage_id: `doc_${i + 1}_chunk_${i}`,
        citation_targets: [],
      },
    ],
  }))
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/answer/route')
  const res = await POST(
    new NextRequest('http://localhost/api/answer', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  )
  return res.json()
}

function sentBody(): any {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  return JSON.parse(call[1].body)
}

beforeEach(() => {
  jest.resetModules()
  process.env = { ...ENV, OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-5.4' }
  delete process.env.OPENAI_BASE_URL
  delete process.env.USE_NANO_FILTER
  fetchMock = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(
      modelReply(
        JSON.stringify({ sentences: ['A.', 'B.'], source_relevance: [] }),
      ),
    )
})
afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ENV }
})

describe('POST /api/answer — defaults reproduce current behaviour', () => {
  it('gpt-5 default: 8 passages, 400 chars, max_completion_tokens, no temperature', async () => {
    const out = await post({ query: 'q', docs: docs(15), prompt_version: 'v1' })
    expect(out.ok).toBe(true)
    expect(out.passages_sent).toHaveLength(8)
    for (const p of out.passages_sent)
      expect(p.text.length).toBeLessThanOrEqual(400)
    const body = sentBody()
    expect(body.model).toBe('gpt-5.4')
    expect(body.max_completion_tokens).toBe(2000)
    expect(body.temperature).toBeUndefined()
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
  })

  it('non-gpt-5 default: 6 passages, 350 chars, max_tokens + temperature', async () => {
    process.env.OPENAI_MODEL = 'gpt-4o-mini'
    const out = await post({ query: 'q', docs: docs(15), prompt_version: 'v1' })
    expect(out.passages_sent).toHaveLength(6)
    for (const p of out.passages_sent)
      expect(p.text.length).toBeLessThanOrEqual(350)
    const body = sentBody()
    expect(body.max_tokens).toBe(1500)
    expect(body.temperature).toBe(0.3)
  })

  it('v1 prompt is the legacy system prompt and the legacy user layout', async () => {
    const { SYS_V1 } = await import('@/app/api/answer/route')
    await post({ query: 'What?', docs: docs(2), prompt_version: 'v1' })
    const body = sentBody()
    expect(body.messages[0]).toEqual({ role: 'system', content: SYS_V1 })
    expect(body.messages[1].content).toContain('Question: What?')
    expect(body.messages[1].content).toContain(
      '[1] "Title 1" (2020)\n   Key finding: ',
    )
    expect(body.messages[1].content).toContain(
      "Task: Evaluate each source's relevance, then write exactly 2-3 clear sentences",
    )
  })

  it('passages_sent carries id, doc_id, chunk_id, page and the exact text sent', async () => {
    const out = await post({
      query: 'q',
      docs: docs(2, 50),
      prompt_version: 'v1',
    })
    expect(out.passages_sent[0]).toEqual({
      id: 1,
      doc_id: 'doc_1',
      chunk_id: 'doc_1_chunk_0',
      page: 1,
      text: expect.any(String),
    })
    expect(sentBody().messages[1].content).toContain(out.passages_sent[0].text)
  })
})

describe('POST /api/answer — v2 cited sentences', () => {
  it('v2 is the default prompt and asks for cites', async () => {
    const { SYS_V2 } = await import('@/app/api/answer/route')
    await post({ query: 'q', docs: docs(3) })
    expect(sentBody().messages[0]).toEqual({ role: 'system', content: SYS_V2 })
    expect(SYS_V2).toContain('"cites"')
  })

  it('returns sentences as strings plus a parallel cites array', async () => {
    fetchMock.mockResolvedValue(
      modelReply(
        JSON.stringify({
          sentences: [
            { text: 'First.', cites: [1, 3] },
            { text: 'Second.', cites: [2] },
          ],
          source_relevance: [{ id: 1, tier: 'strong' }],
        }),
      ),
    )
    const out = await post({ query: 'q', docs: docs(3) })
    expect(out.synthesis.sentences).toEqual(['First.', 'Second.'])
    expect(out.synthesis.cites).toEqual([[1, 3], [2]])
    expect(out.debug.invalid_cites).toBe(0)
  })

  it('drops cites that are not in passages_sent and counts them', async () => {
    fetchMock.mockResolvedValue(
      modelReply(
        JSON.stringify({
          sentences: [
            { text: 'First.', cites: [1, 9, 1, 0, 'x'] },
            { text: 'Second.', cites: [] },
          ],
        }),
      ),
    )
    const out = await post({ query: 'q', docs: docs(3) })
    expect(out.synthesis.cites).toEqual([[1], []])
    expect(out.debug.invalid_cites).toBe(3) // 9, 0, 'x' (duplicate 1 is deduped, not counted)
  })

  it('accepts legacy string sentences with empty cites', async () => {
    fetchMock.mockResolvedValue(
      modelReply(JSON.stringify({ sentences: ['A.', 'B.'] })),
    )
    const out = await post({ query: 'q', docs: docs(3) })
    expect(out.synthesis.sentences).toEqual(['A.', 'B.'])
    expect(out.synthesis.cites).toEqual([[], []])
  })

  it('likely_off_topic forces the low_coverage warning and tells the model', async () => {
    const out = await post({
      query: 'q',
      docs: docs(3),
      likely_off_topic: true,
    })
    expect(out.synthesis.warning).toBe('low_coverage')
    expect(sentBody().messages[1].content).toContain('Coverage check:')
  })
})

describe('POST /api/answer — knobs', () => {
  it('max_passages and passage_chars override the defaults', async () => {
    const out = await post({
      query: 'q',
      docs: docs(15),
      max_passages: 12,
      passage_chars: 800,
    })
    expect(out.passages_sent).toHaveLength(12)
    expect(Math.max(...out.passages_sent.map((p: any) => p.text.length))).toBe(
      800,
    )
    expect(out.debug.knobs).toMatchObject({
      max_passages: 12,
      passage_chars: 800,
    })
  })

  it('max_passages is capped at 15', async () => {
    const out = await post({ query: 'q', docs: docs(20), max_passages: 40 })
    expect(out.passages_sent).toHaveLength(15)
  })

  it('model + base_url reach the provider, and the lunaroute key is used', async () => {
    process.env.LUNAROUTE_BASE_URL = 'https://gw.lunaroute.com/v1'
    process.env.LUNAROUTE_API_KEY = 'lr-key'
    await post({
      query: 'q',
      docs: docs(3),
      model: 'glm-5.2-vision',
      base_url: 'https://gw.lunaroute.com/v1',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gw.lunaroute.com/v1/chat/completions')
    expect(init.headers.authorization).toBe('Bearer lr-key')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('glm-5.2-vision')
    expect(body.max_tokens).toBeDefined() // non-gpt-5 branch
  })

  it('a missing key for the resolved provider returns the fallback, no call', async () => {
    delete process.env.OPENAI_API_KEY
    const out = await post({ query: 'q', docs: docs(3) })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.debug.fallbackReason).toBe('no_api_key')
  })
})
