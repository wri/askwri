/**
 * @jest-environment node
 *
 * Contract tests for POST /api/alignment. The provider is a mocked global fetch,
 * so each test asserts on what would have been sent to the model and on the
 * `provenance` block that says whether a model produced the assessment at all —
 * this route answers 200 `ok: true` on every failure, including the sanitizer's
 * substitution of the canned insight. `resolveAlignmentConfig` lives in
 * `src/lib/alignment-config.ts` — a `route.ts` may export routes only — and its
 * tests are here because the route is the sole consumer.
 */
import { NextRequest } from 'next/server'

const ENV = { ...process.env }
let fetchMock: jest.SpyInstance

const SUMMARY =
  'Results for: How do cities cool streets?\n1. Urban cooling — tree canopy reduces street temperature.'

const ASSESSMENT = {
  insights: [
    'Tree canopy studies directly measure how shade cools streets.',
    'Rooftop albedo evidence is thinner but still directly relevant.',
  ],
  alignment: 'High',
}

const CANNED_INSIGHT =
  'Unable to assess alignment. Try providing more sources or refining your query.'

function chatReply(content: string, status = 200) {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { total_tokens: 42 },
    }),
    { status },
  )
}

async function post(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const { POST } = await import('@/app/api/alignment/route')
  const res = await POST(
    new NextRequest('http://localhost/api/alignment', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    }),
  )
  return { status: res.status, json: await res.json() }
}

// A failing attempt is retried twice (tools, json_object), and a Response body
// can be read once — so every `fetch` needs its own reply.
function mockReply(content: string, status = 200) {
  fetchMock.mockImplementation(async () => chatReply(content, status))
}

// The interesting body is the last one sent.
function sentBody(): any {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  return JSON.parse(call[1].body)
}

async function configFor(model: string) {
  const { resolveAlignmentConfig } = await import('@/lib/alignment-config')
  return resolveAlignmentConfig(model)
}

beforeEach(() => {
  jest.resetModules()
  process.env = {
    ...ENV,
    OPENAI_API_KEY: 'sk-test',
    OPENAI_MODEL: 'gpt-5-mini',
  }
  // A developer's deploy-day .env — loaded by next/jest even under NODE_ENV=test —
  // must not masquerade as the route's default, and no machine-wide cap, timeout,
  // temperature or sweep token may silently satisfy an assertion.
  delete process.env.OPENAI_MODEL_ALIGNMENT
  delete process.env.OPENAI_MAX_TOKENS
  delete process.env.OPENAI_TEMPERATURE
  delete process.env.ALIGNMENT_TIMEOUT_MS_MAIN
  delete process.env.ALIGNMENT_TIMEOUT_MS_REPAIR
  delete process.env.EVAL_MODEL_OVERRIDE_TOKEN
  jest.spyOn(console, 'log').mockImplementation()
  jest.spyOn(console, 'warn').mockImplementation()
  jest.spyOn(console, 'error').mockImplementation()
  fetchMock = jest.spyOn(global, 'fetch')
  mockReply(JSON.stringify(ASSESSMENT))
})

afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ENV }
})

describe('resolveAlignmentConfig', () => {
  it('derives GPT-5 timeouts and caps for a gpt-5 model', async () => {
    expect(await configFor('gpt-5-mini')).toEqual({
      model: 'gpt-5-mini',
      isGpt5: true,
      mainMs: 40000,
      repairMs: 25000,
      mainMax: 4000,
      repairMax: 5000,
      temperature: 0.3,
    })
  })

  it('derives non-GPT-5 timeouts and caps for other models', async () => {
    const cfg = await configFor('gpt-4o-mini')
    expect(cfg.isGpt5).toBe(false)
    expect(cfg.mainMs).toBe(20000)
    expect(cfg.repairMs).toBe(12000)
    // The cap only ever tightens for a non-GPT-5 model.
    expect(cfg.mainMax).toBeLessThanOrEqual(1500)
    expect(cfg.repairMax).toBe(Math.min(cfg.mainMax + 500, 2000))
  })

  it('reads the timeout and cap env at call time, not at import time', async () => {
    // Imported before the env is set: a module-scope const would have frozen the
    // defaults and this test would see 20000 / the configured cap ignored.
    const { resolveAlignmentConfig } = await import('@/lib/alignment-config')
    process.env.ALIGNMENT_TIMEOUT_MS_MAIN = '33000'
    process.env.OPENAI_MAX_TOKENS = '1200'
    const cfg = resolveAlignmentConfig('gpt-4o-mini')
    expect(cfg.mainMs).toBe(33000)
    expect(cfg.mainMax).toBe(1200)
  })
})

describe('POST /api/alignment — model resolution', () => {
  it('returns 400 for an override with no token', async () => {
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      resultsSummary: SUMMARY,
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

  it('sends the resolved model, not the module const', async () => {
    process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
    const { status, json } = await post(
      {
        query: 'How do cities cool streets?',
        resultsSummary: SUMMARY,
        model: 'gpt-4o-mini',
      },
      { 'x-eval-token': 'secret' },
    )
    expect(status).toBe(200)
    expect(json.provenance).toEqual({
      model: 'gpt-4o-mini',
      produced: true,
    })
    expect(sentBody().model).toBe('gpt-4o-mini')
    // The non-GPT-5 ladder: max_tokens + temperature. The module default is a
    // gpt-5 name, whose parameters would have been sent instead.
    expect(sentBody().max_tokens).toBe(1000)
    expect(sentBody().temperature).toBe(0.3)
    expect(sentBody().max_completion_tokens).toBeUndefined()
  })

  it('keeps the GPT-5 parameters for the default model', async () => {
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      resultsSummary: SUMMARY,
    })
    expect(status).toBe(200)
    expect(json.provenance.model).toBe('gpt-5-mini')
    expect(sentBody().model).toBe('gpt-5-mini')
    expect(sentBody().max_completion_tokens).toBe(4000)
    expect(sentBody().max_tokens).toBeUndefined()
    expect(sentBody().temperature).toBeUndefined()
  })
})

describe('POST /api/alignment — provenance marks every path that produced nothing', () => {
  it('reports produced true on a parseable assessment', async () => {
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      resultsSummary: SUMMARY,
    })
    expect(status).toBe(200)
    expect(json.assessment).toEqual(ASSESSMENT)
    expect(json.provenance).toEqual({ model: 'gpt-5-mini', produced: true })
    // The pre-existing debug signal keeps its shape.
    expect(json.debug.fallback).toBe(false)
    expect(json.debug.used).toBe('json_schema')
    expect(json.debug.model).toBe('gpt-5-mini')
  })

  it('reports produced false and reason no_text for a missing query', async () => {
    const { status, json } = await post({ resultsSummary: SUMMARY })
    expect(status).toBe(400)
    expect(json).toEqual({
      ok: false,
      error: 'Missing query',
      provenance: {
        model: 'gpt-5-mini',
        produced: false,
        fallback_reason: 'no_text',
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports produced false and reason no_api_key when the key is missing', async () => {
    delete process.env.OPENAI_API_KEY
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      resultsSummary: SUMMARY,
    })
    expect(status).toBe(200)
    expect(json.assessment.alignment).toBe('Low')
    expect(json.debug).toEqual({
      fallback: true,
      reason: 'missing_api_key',
      model: 'gpt-5-mini',
    })
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'no_api_key',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports produced false and reason upstream_500 on provider error', async () => {
    mockReply('', 500)
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      resultsSummary: SUMMARY,
    })
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.assessment.alignment).toBe('Moderate')
    // The deterministic fallback's own fields are untouched.
    expect(json.debug.fallback).toBe(true)
    expect(json.debug.reason).toBe('http_500')
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'upstream_500',
    })
  })

  it('reports produced false and reason parse_error on empty content', async () => {
    mockReply('')
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      resultsSummary: SUMMARY,
    })
    expect(status).toBe(200)
    expect(json.debug.fallback).toBe(true)
    expect(json.debug.reason).toBe('empty_or_unparseable_content')
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'parse_error',
    })
  })

  it('reports the exception path as not produced', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      resultsSummary: SUMMARY,
    })
    expect(status).toBe(200)
    // No HTTP status was ever seen, so the reason is the route's, not
    // `upstream_0` — 0 is not something a provider returned.
    expect(json.debug.reason).toBe('http_0')
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: false,
      fallback_reason: 'error',
    })
  })
})

describe('POST /api/alignment — provenance marks what the sanitizer rewrote', () => {
  it('reports sanitized true when sanitizeAssessment substitutes the insights', async () => {
    mockReply(
      JSON.stringify({
        insights: ['该文件概述了树冠降温的证据。'],
        alignment: 'High',
      }),
    )
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      resultsSummary: SUMMARY,
    })
    expect(status).toBe(200)
    expect(json.assessment.insights).toEqual([CANNED_INSIGHT])
    // The model answered, so the row is still model output — but not one word of
    // the insight is text it wrote.
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: true,
      sanitized: true,
    })
    expect(json.debug.fallback).toBe(false)
  })

  it('reports sanitized true when sanitizeAssessment coerces the alignment value', async () => {
    mockReply(
      JSON.stringify({
        insights: ASSESSMENT.insights,
        alignment: 'Medium',
      }),
    )
    const { status, json } = await post({
      query: 'How do cities cool streets?',
      resultsSummary: SUMMARY,
    })
    expect(status).toBe(200)
    expect(json.assessment.alignment).toBe('Moderate')
    expect(json.assessment.insights).toEqual(ASSESSMENT.insights)
    expect(json.provenance).toEqual({
      model: 'gpt-5-mini',
      produced: true,
      sanitized: true,
    })
  })

  it('does not report sanitized when the assessment passes through intact', async () => {
    const { json } = await post({
      query: 'How do cities cool streets?',
      resultsSummary: SUMMARY,
    })
    expect(json.provenance.sanitized).toBeUndefined()
  })
})
