/**
 * @jest-environment node
 *
 * Contract tests for POST /api/translate. The provider is a mocked global fetch,
 * so every test asserts on exactly what would have been sent to the model and on
 * the `provenance` block that says whether a model produced the text at all.
 */
import { NextRequest } from 'next/server'

const ENV = { ...process.env }
let fetchMock: jest.SpyInstance

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
  const { POST } = await import('@/app/api/translate/route')
  const res = await POST(
    new NextRequest('http://localhost/api/translate', {
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
    MODEL_TRANSLATE: 'gpt-5-mini',
  }
  // A developer's deploy-day .env — loaded by next/jest even under NODE_ENV=test —
  // must not masquerade as the route's default, and no test inherits a sweep token.
  delete process.env.EVAL_MODEL_OVERRIDE_TOKEN
  jest.spyOn(console, 'error').mockImplementation()
  fetchMock = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(chatReply('Hello world'))
})

afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ENV }
})

describe('POST /api/translate — model resolution', () => {
  it('defaults to the env model and reports it', async () => {
    process.env.MODEL_TRANSLATE = 'gpt-5.4-mini'
    const { status, json } = await post({ text: 'Hola mundo' })
    expect(status).toBe(200)
    expect(json.provenance).toEqual({ model: 'gpt-5.4-mini', produced: true })
    expect(json.model).toBe('gpt-5.4-mini')
    // GPT-5 keeps spending reasoning tokens out of the same budget.
    expect(sentBody().max_completion_tokens).toBe(2000)
    expect(sentBody().temperature).toBeUndefined()
  })

  it('rejects an override with no token', async () => {
    const { status, json } = await post({ text: 'Hola', model: 'gpt-5.6-luna' })
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

  it('runs the requested model when the token matches', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    const { json } = await post(
      { text: 'Hola', model: 'gpt-5.6-luna' },
      { 'x-eval-token': 'secret' },
    )
    expect(json.provenance).toEqual({ model: 'gpt-5.6-luna', produced: true })
    expect(json.model).toBe('gpt-5.6-luna')
    expect(sentBody().model).toBe('gpt-5.6-luna')
  })

  it('computes MAX_TOKENS from the resolved model, not the module const', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    await post(
      { text: 'Hola', model: 'gpt-4o-mini' },
      { 'x-eval-token': 'secret' },
    )
    expect(sentBody().max_tokens).toBe(1200)
    expect(sentBody().temperature).toBe(0.2)
  })
})

describe('POST /api/translate — usage', () => {
  it('passes the provider usage through, so a sweep can price the call', async () => {
    const usage = {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
    }
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'Hello' } }],
          usage,
        }),
        { status: 200 },
      ),
    )
    const { json } = await post({ text: 'Hola' })
    expect(json.usage).toEqual(usage)
  })

  it('omits usage when the provider sends none', async () => {
    const { json } = await post({ text: 'Hola' })
    expect(json).not.toHaveProperty('usage')
  })
})

describe('POST /api/translate — provenance marks every path that produced nothing', () => {
  it('reports the missing-text path as not produced', async () => {
    const { status, json } = await post({ text: '   ' })
    expect(status).toBe(400)
    expect(json).toEqual({
      ok: false,
      error: 'text is required',
      provenance: {
        model: 'gpt-5-mini',
        produced: false,
        fallback_reason: 'no_text',
      },
    })
  })

  it('reports the provider-error path as not produced', async () => {
    fetchMock.mockResolvedValue(chatReply('', 500))
    const { status, json } = await post({ text: 'Hola' })
    expect(status).toBe(502)
    expect(json).toEqual({
      ok: false,
      error: 'Translation service unavailable',
      provenance: {
        model: 'gpt-5-mini',
        produced: false,
        fallback_reason: 'upstream_500',
      },
    })
  })

  it('reports an empty completion as not produced', async () => {
    fetchMock.mockResolvedValue(chatReply('   '))
    const { status, json } = await post({ text: 'Hola' })
    expect(status).toBe(502)
    expect(json).toEqual({
      ok: false,
      error: 'Empty translation',
      provenance: {
        model: 'gpt-5-mini',
        produced: false,
        fallback_reason: 'empty_translation',
      },
    })
  })

  it('reports the API-key-missing path as not produced', async () => {
    delete process.env.OPENAI_API_KEY
    const { status, json } = await post({ text: 'Hola' })
    expect(status).toBe(500)
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'no_api_key',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports the exception path as not produced', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { status, json } = await post({ text: 'Hola' })
    expect(status).toBe(500)
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'error',
    })
  })
})
