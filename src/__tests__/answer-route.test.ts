/**
 * @jest-environment node
 *
 * Contract tests for POST /api/answer. The provider is a mocked global fetch
 * so every test asserts on exactly what would have been sent to the model.
 */
import { NextRequest } from 'next/server'
import { createHash } from 'node:crypto'

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

async function postWithStatus(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/answer/route')
  const res = await POST(
    new NextRequest('http://localhost/api/answer', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  )
  return { status: res.status, json: await res.json() }
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
    const out = await post({ query: 'q', docs: docs(15) })
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

  it('pins the exact legacy v1 provider request independently of route constants', async () => {
    const fixedDoc = {
      doc_id: 'fixed-doc',
      title: 'Fixed title',
      year: 2024,
      kps: [
        {
          kp_relevance: 0.9,
          snippet: 'Fixed evidence.',
          page: 3,
          passage_id: 'fixed-passage',
          citation_targets: [],
        },
      ],
    }
    await post({ query: 'What?', docs: [fixedDoc], prompt_version: 'v1' })
    const body = sentBody()
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    })
    expect(body).toEqual({
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: expect.any(String) },
        {
          role: 'user',
          content: `Question: What?

Source documents with key findings:
[1] "Fixed title" (2024)
   Key finding: Fixed evidence.

Task: Evaluate each source's relevance, then write exactly 2-3 clear sentences synthesizing the most important information from the relevant sources. Focus on breadth - touch on multiple key findings rather than elaborating on one.`,
        },
      ],
      max_completion_tokens: 2000,
    })
    expect(
      createHash('sha256').update(body.messages[0].content).digest('hex'),
    ).toBe('3d9f95184ac5fea90fd0c9f767f4405922c7926084c2a33965c84e9503f48aa0')
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

  it('renumbers nano-filtered passages so cite ids are positional', async () => {
    process.env.USE_NANO_FILTER = 'true'
    fetchMock
      .mockResolvedValueOnce(
        modelReply(
          JSON.stringify({
            relevance: [
              { id: 1, tier: 'weak' },
              { id: 2, tier: 'strong' },
              { id: 3, tier: 'weak' },
              { id: 4, tier: 'partial' },
            ],
            coverage: 'good',
          }),
        ),
      )
      .mockResolvedValueOnce(
        modelReply(
          JSON.stringify({
            sentences: [{ text: 'Answer.', cites: [1, 2] }],
          }),
        ),
      )

    const out = await post({ query: 'q', docs: docs(4) })

    expect(out.passages_sent).toEqual([
      expect.objectContaining({ id: 1, doc_id: 'doc_2' }),
      expect.objectContaining({ id: 2, doc_id: 'doc_4' }),
    ])
    expect(out.synthesis.cites).toEqual([[1, 2]])
    expect(sentBody().messages[1].content).toContain('[1] "Title 2"')
    expect(sentBody().messages[1].content).toContain('[2] "Title 4"')
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

  it('rejects an unconfigured base_url without exposing a provider key', async () => {
    const { status, json } = await postWithStatus({
      query: 'q',
      docs: docs(3),
      base_url: 'https://attacker.example/v1',
    })
    expect(status).toBe(400)
    expect(json).toEqual({ ok: false, error: 'Unsupported provider base_url' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a missing key for the resolved provider returns the fallback, no call', async () => {
    delete process.env.OPENAI_API_KEY
    const out = await post({
      query: 'q',
      docs: docs(3),
      likely_off_topic: true,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.debug.fallbackReason).toBe('no_api_key')
    expect(out.synthesis.cites).toEqual([[], []])
    expect(out.synthesis.warning).toBe('low_coverage')
  })

  it('an upstream API error preserves the off-topic warning', async () => {
    fetchMock.mockResolvedValue(modelReply('upstream error', 500))
    const out = await post({
      query: 'q',
      docs: docs(3),
      likely_off_topic: true,
    })
    expect(out.debug.fallbackReason).toBe('api_error')
    expect(out.synthesis.warning).toBe('low_coverage')
  })

  it('exception and fallback paths carry parallel empty cites and the off-topic warning', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const out = await post({
      query: 'q',
      docs: docs(3),
      likely_off_topic: true,
    })
    expect(out.ok).toBe(true)
    expect(out.synthesis.sentences).toHaveLength(1)
    expect(out.synthesis.cites).toEqual([[]])
    expect(out.synthesis.warning).toBe('low_coverage')
  })
})
