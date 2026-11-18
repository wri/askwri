/**
 * @jest-environment node
 *
 * Contract tests for POST /api/batch-why. The provider is a mocked global fetch,
 * so each test asserts on what would have been sent to the model and on the
 * `provenance` block that says whether a model produced the explanations at all
 * — this route answers 200 `ok: true` with canned sentences on every failure and
 * substitutes them silently for mirrored output.
 */
import { NextRequest } from 'next/server'

const ENV = { ...process.env }
let fetchMock: jest.SpyInstance

const PASSAGES = [
  {
    docTitle: 'Urban cooling',
    snippet: 'Tree canopy reduces street temperature.',
  },
  {
    docTitle: 'Rooftop albedo',
    snippet: 'White roofs reflect solar radiation.',
  },
]

// 40 passages push the token calculation (200 + 40 * 80 = 3400) past both caps,
// so the cap itself reveals which model the route sized for.
const MANY_PASSAGES = Array.from({ length: 40 }, (_, i) => ({
  docTitle: `Doc ${i + 1}`,
  snippet: 'Short snippet.',
}))

const CANNED = {
  why: 'This passage provides relevant context for the query.',
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
  const { POST } = await import('@/app/api/batch-why/route')
  const res = await POST(
    new NextRequest('http://localhost/api/batch-why', {
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
    MODEL_WHY: 'gpt-5-mini',
  }
  // A developer's deploy-day .env — loaded by next/jest even under NODE_ENV=test —
  // must not masquerade as the route's default, no test may inherit a sweep token,
  // and no machine-wide token cap or temperature may leak into an assertion.
  delete process.env.OPENAI_MAX_TOKENS
  delete process.env.OPENAI_TEMPERATURE
  delete process.env.EVAL_MODEL_OVERRIDE_TOKEN
  jest.spyOn(console, 'log').mockImplementation()
  jest.spyOn(console, 'error').mockImplementation()
  fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
    chatReply(
      JSON.stringify([
        { why: 'Both measure how shade cools streets.', relation: 'direct' },
        { why: 'Both concern reflective surfaces.', relation: 'indirect' },
      ]),
    ),
  )
})

afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ENV }
})

describe('POST /api/batch-why — model resolution', () => {
  it('returns 400 for an override with no token', async () => {
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      passages: PASSAGES,
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

  it('returns 400 for an override carrying the wrong token', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    const { status, json } = await post(
      {
        query: 'How do cities cool streets?',
        passages: PASSAGES,
        model: 'gpt-5.6-luna',
      },
      { 'x-eval-token': 'not-the-secret' },
    )
    expect(status).toBe(400)
    expect(json.error).toBe('invalid eval token')
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'model_override_rejected',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sizes tokens from the resolved model, not the module default', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    const { status, json } = await post(
      {
        query: 'How do cities cool streets?',
        passages: MANY_PASSAGES,
        model: 'gpt-4o-mini',
      },
      { 'x-eval-token': 'secret' },
    )
    expect(status).toBe(200)
    expect(json.provenance.model).toBe('gpt-4o-mini')
    expect(sentBody().model).toBe('gpt-4o-mini')
    // 3400 requested → the non-GPT-5 cap of 2500. The module default is a
    // gpt-5 name, which would have capped at 3000.
    expect(sentBody().max_completion_tokens).toBe(2500)
    expect(sentBody().temperature).toBe(0.3)
  })

  it('keeps the GPT-5 cap and parameters for the default model', async () => {
    await post({
      query: 'How do cities cool streets?',
      passages: MANY_PASSAGES,
    })
    expect(sentBody().model).toBe('gpt-5-mini')
    expect(sentBody().max_completion_tokens).toBe(3000)
    expect(sentBody().temperature).toBeUndefined()
    expect(sentBody().max_tokens).toBeUndefined()
  })
})

describe('POST /api/batch-why — provenance marks every path that produced nothing', () => {
  it('reports produced true on a parsed success', async () => {
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      passages: PASSAGES,
    })
    expect(status).toBe(200)
    expect(json.explanations).toEqual([
      { why: 'Both measure how shade cools streets.', relation: 'direct' },
      { why: 'Both concern reflective surfaces.', relation: 'indirect' },
    ])
    expect(json.provenance).toEqual({ model: 'gpt-5-mini', produced: true })
  })

  it('reports produced false and reason no_docs for a request with no passages', async () => {
    const { status, json } = await post({
      query: 'How do cities cool streets?',
    })
    expect(status).toBe(400)
    expect(json.error).toBe('Invalid request format')
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'no_docs',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports produced false and reason no_api_key when the key is missing', async () => {
    delete process.env.OPENAI_API_KEY
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      passages: PASSAGES,
    })
    expect(status).toBe(500)
    expect(json.error).toBe('OPENAI_API_KEY not configured')
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
      passages: PASSAGES,
    })
    expect(status).toBe(500)
    expect(json.error).toContain('OpenAI API error: 500')
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'upstream_500',
    })
  })

  it('reports produced false and reason parse_error on unparseable content', async () => {
    fetchMock.mockResolvedValue(chatReply('I cannot help with that.'))
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      passages: PASSAGES,
    })
    expect(status).toBe(200)
    // The existing fallback signal keeps its field and shape.
    expect(json.fallback).toBe(true)
    expect(json.explanations).toEqual([CANNED, CANNED])
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'parse_error',
    })
  })

  it('reports produced false and reason parse_error when the array is empty', async () => {
    fetchMock.mockResolvedValue(chatReply('[]'))
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      passages: PASSAGES,
    })
    expect(status).toBe(200)
    // "[]" parses, but every row is padding — no word of it is the model's.
    expect(json.explanations).toEqual([CANNED, CANNED])
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'parse_error',
      // The padding that emptied `written` is still reported as a substitution.
      sanitized: true,
    })
    // The success path's raw content is not lost when the answer is all padding.
    expect(json.debug).toEqual({ parseError: true, rawContent: '[]' })
  })

  it('reports sanitized true when every explanation is mirrored', async () => {
    fetchMock.mockResolvedValue(
      chatReply(
        JSON.stringify([
          { why: '该文件概述了树冠降温的证据。', relation: 'direct' },
          { why: '白色屋顶反射太阳辐射。', relation: 'direct' },
        ]),
      ),
    )
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      passages: PASSAGES,
    })
    expect(status).toBe(200)
    // Every row was replaced by the English fallback, so no explanation here is
    // the model's own text even though the model returned an array of answers.
    expect(json.explanations.map((exp: any) => exp.why)).toEqual([
      CANNED.why,
      CANNED.why,
    ])
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'parse_error',
      sanitized: true,
    })
    expect(json.debug.parseError).toBe(true)
    expect(json.debug.rawContent).toContain('该文件概述了树冠降温的证据。')
  })

  it('reports sanitized true when the English guard replaces a mirrored explanation', async () => {
    fetchMock.mockResolvedValue(
      chatReply(
        JSON.stringify([
          { why: '该文件概述了树冠降温的证据。', relation: 'direct' },
          {
            why: 'Both concern reflective surfaces.',
            relation: 'indirect',
          },
        ]),
      ),
    )
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      passages: PASSAGES,
    })
    expect(status).toBe(200)
    expect(json.explanations).toEqual([
      CANNED,
      { why: 'Both concern reflective surfaces.', relation: 'indirect' },
    ])
    // The model answered; only the mirrored row was replaced.
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: true,
      sanitized: true,
    })
  })

  it('reports sanitized true when the model answers fewer passages than it was given', async () => {
    fetchMock.mockResolvedValue(
      chatReply(
        JSON.stringify([
          { why: 'Both measure how shade cools streets.', relation: 'direct' },
        ]),
      ),
    )
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      passages: PASSAGES,
    })
    expect(status).toBe(200)
    expect(json.explanations).toEqual([
      { why: 'Both measure how shade cools streets.', relation: 'direct' },
      CANNED,
    ])
    // The model answered one passage, so the response still carries model text —
    // but the padded row is text it never wrote.
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: true,
      sanitized: true,
    })
  })

  it('reports the exception path as not produced', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      passages: PASSAGES,
    })
    expect(status).toBe(500)
    expect(json.error).toBe('boom')
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'error',
    })
  })
})
