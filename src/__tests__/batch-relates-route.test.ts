/**
 * @jest-environment node
 *
 * Contract tests for POST /api/batch-relates. The provider is a mocked global
 * fetch, so each test asserts on what would have been sent to the model and on
 * the `provenance` block that says whether a model produced the explanations at
 * all — this route answers 200 `ok: true` with canned sentences on every failure.
 */
import { NextRequest } from 'next/server'

const ENV = { ...process.env }
let fetchMock: jest.SpyInstance

const DOCS = [
  {
    title: 'Urban cooling',
    authors: 'A. Author',
    year: '2021',
    snippet: 'Tree canopy reduces street temperature.',
  },
  {
    title: 'Rooftop albedo',
    authors: 'B. Author',
    year: '2022',
    snippet: 'White roofs reflect solar radiation.',
  },
]

const CANNED = {
  relates: 'Relevant supporting evidence.',
  relation: 'indirect',
}

function chatReply(content: string, status = 200) {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content } }],
    }),
    { status },
  )
}

async function post(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const { POST } = await import('@/app/api/batch-relates/route')
  const res = await POST(
    new NextRequest('http://localhost/api/batch-relates', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
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
  process.env = {
    ...ENV,
    OPENAI_API_KEY: 'sk-test',
    OPENAI_MODEL: 'gpt-5-mini',
  }
  // A developer's deploy-day .env — loaded by next/jest even under NODE_ENV=test —
  // must not masquerade as the route's default, and no test inherits a sweep token
  // or a machine-wide temperature.
  delete process.env.OPENAI_MODEL_RELATES
  delete process.env.EVAL_MODEL_OVERRIDE_TOKEN
  delete process.env.OPENAI_TEMPERATURE
  jest.spyOn(console, 'error').mockImplementation()
  fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
    chatReply(
      JSON.stringify([
        {
          relates: 'Both measure how shade cools streets.',
          relation: 'direct',
        },
        { relates: 'Both concern reflective surfaces.', relation: 'indirect' },
      ]),
    ),
  )
})

afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ENV }
})

describe('POST /api/batch-relates — model resolution', () => {
  it('rejects an override with no token', async () => {
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      docs: DOCS,
      model: 'gpt-5.6-luna',
    })
    expect(status).toBe(400)
    expect(json).toEqual({
      ok: false,
      error: 'model override not enabled',
      provenance: {
        model: 'gpt-5-mini',
        produced: false,
        fallback_reason: 'model_override_rejected',
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('computes output tokens from the resolved model, not the module const', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    const { status, json } = await post(
      {
        query: 'How do cities cool streets?',
        docs: DOCS,
        model: 'gpt-4o-mini',
      },
      { 'x-eval-token': 'secret' },
    )
    expect(status).toBe(200)
    expect(json.provenance.model).toBe('gpt-4o-mini')
    expect(sentBody().model).toBe('gpt-4o-mini')
    // Two docs → 240 tokens; the module default is a gpt-5 name, which would
    // have sent max_completion_tokens and no temperature.
    expect(sentBody().max_tokens).toBe(240)
    expect(sentBody().temperature).toBe(0.2)
    expect(sentBody().max_completion_tokens).toBeUndefined()
  })

  it('keeps the GPT-5 parameters for a gpt-5 default', async () => {
    await post({ query: 'How do cities cool streets?', docs: DOCS })
    expect(sentBody().max_completion_tokens).toBe(1000)
    expect(sentBody().max_tokens).toBeUndefined()
    expect(sentBody().temperature).toBeUndefined()
  })
})

describe('POST /api/batch-relates — provenance marks every path that produced nothing', () => {
  it('reports produced true on a parsed success', async () => {
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      docs: DOCS,
    })
    expect(status).toBe(200)
    expect(json.results).toEqual([
      { relates: 'Both measure how shade cools streets.', relation: 'direct' },
      { relates: 'Both concern reflective surfaces.', relation: 'indirect' },
    ])
    expect(json.model).toBe('gpt-5-mini')
    expect(json.provenance).toEqual({ model: 'gpt-5-mini', produced: true })
  })

  it('reports produced false and reason no_docs for an empty doc list', async () => {
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      docs: [],
    })
    expect(status).toBe(200)
    expect(json).toEqual({
      ok: true,
      results: [],
      provenance: {
        model: 'gpt-5-mini',
        produced: false,
        fallback_reason: 'no_docs',
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports produced false and reason no_api_key when the key is missing', async () => {
    delete process.env.OPENAI_API_KEY
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      docs: DOCS,
    })
    expect(status).toBe(200)
    expect(json.results).toEqual([CANNED, CANNED])
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'no_api_key',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports produced false and reason upstream_500 on provider error', async () => {
    fetchMock.mockResolvedValue(chatReply('', 500))
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      docs: DOCS,
    })
    expect(status).toBe(200)
    expect(json.results).toEqual([CANNED, CANNED])
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'upstream_500',
    })
    // The existing debug signal keeps its shape.
    expect(json.debug.status).toBe(500)
  })

  it('reports produced false and reason parse_error on unparseable content', async () => {
    fetchMock.mockResolvedValue(chatReply('I cannot help with that.'))
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      docs: DOCS,
    })
    expect(status).toBe(200)
    expect(json.results).toEqual([CANNED, CANNED])
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'parse_error',
    })
    expect(json.debug.parseError).toBe(true)
  })

  it('reports the exception path as not produced', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      docs: DOCS,
    })
    expect(status).toBe(200)
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'error',
    })
  })

  it('reports produced false and reason parse_error for a parsed but empty array', async () => {
    fetchMock.mockResolvedValue(chatReply('[]'))
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      docs: DOCS,
    })
    expect(status).toBe(200)
    // "[]" parses, so every row is padding — no word of it is the model's.
    expect(json.results).toEqual([CANNED, CANNED])
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'parse_error',
    })
    expect(json.debug.parseError).toBe(true)
  })

  it('reports sanitized true when the model answers fewer docs than it was given', async () => {
    fetchMock.mockResolvedValue(
      chatReply(
        JSON.stringify([
          {
            relates: 'Both measure how shade cools streets.',
            relation: 'direct',
          },
        ]),
      ),
    )
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      docs: DOCS,
    })
    expect(status).toBe(200)
    expect(json.results).toEqual([
      { relates: 'Both measure how shade cools streets.', relation: 'direct' },
      CANNED,
    ])
    // The model answered one doc, so the response still has model text — but the
    // padded row is text it never wrote.
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: true,
      sanitized: true,
    })
  })

  it('reports sanitized true when the English fallback replaces mirrored output', async () => {
    fetchMock.mockResolvedValue(
      chatReply(
        JSON.stringify([
          { relates: '该文件概述了树冠降温的证据。', relation: 'direct' },
          {
            relates: 'Both concern reflective surfaces.',
            relation: 'indirect',
          },
        ]),
      ),
    )
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      docs: DOCS,
    })
    expect(status).toBe(200)
    expect(json.results).toEqual([
      CANNED,
      { relates: 'Both concern reflective surfaces.', relation: 'indirect' },
    ])
    // The model answered; only the mirrored row was replaced.
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: true,
      sanitized: true,
    })
  })
})
