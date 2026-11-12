/** @jest-environment node */

// `resolveCodeVersion` shells out to the aws CLI; mocking the module keeps the
// suite off the network and off whatever credentials happen to be in the shell.
jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }))

import { execFileSync } from 'node:child_process'
import { checkCall, inputCount } from '../route-sweep/checks'
import { resolveCodeVersion, runSweep } from '../route-sweep/sweep'
import type { CallResult, FrozenCase } from '../route-sweep/types'

const TARGET = 'https://qa.askwrimvp.test'
const MODEL_A = 'gpt-5.4-nano'
const MODEL_B = 'gpt-5.6-luna'
const TOKEN = 'eval-token'

const doc = (docId: string, snippet: string) => ({
  doc_id: docId,
  ref: docId,
  title: `title ${docId}`,
  kps: [{ kp_relevance: 0.7, snippet, passage_id: `${docId}_chunk_1` }],
})

const frozenCase = (id: string, docs: any[]): FrozenCase => ({
  id,
  question: `question for ${id}`,
  docs,
  doc_count: docs.length,
})

/** A call that passed every mechanical check, for tests to break one field of. */
const passing = (overrides: Partial<CallResult> = {}): CallResult => ({
  route: 'translate',
  case_id: 'q1',
  model: MODEL_A,
  request: { text: '在测算新能源重卡', model: MODEL_A },
  response: { ok: true, translation: '译文', provenance: { model: MODEL_A } },
  provenance: { model: MODEL_A, produced: true },
  latency_ms: 1200,
  ...overrides,
})

type FetchCall = { url: string; init: RequestInit }

/** A fake target that answers every route with a well-formed response echoing
 * the model it was asked for — i.e. what a healthy deployment should do. */
function echoModelFetch(): {
  fetchImpl: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init })
    const body = JSON.parse(String(init.body))
    const provenance = { model: body.model, produced: true }
    const payload = url.endsWith('/batch-why')
      ? {
          ok: true,
          explanations: [
            { why: 'why a', relation: 'direct' },
            { why: 'why b', relation: 'indirect' },
          ],
          provenance,
        }
      : url.endsWith('/batch-relates')
        ? {
            ok: true,
            results: [
              { relates: 'relates a', relation: 'direct' },
              { relates: 'relates b', relation: 'indirect' },
            ],
            provenance,
          }
        : url.endsWith('/alignment')
          ? {
              ok: true,
              assessment: { insights: ['insight'], alignment: 'Moderate' },
              provenance,
            }
          : { ok: true, translation: '译文', model: body.model, provenance }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const sweepArgs = (overrides: Record<string, unknown> = {}) => ({
  cases: [frozenCase('q1', [doc('a', 'snippet a'), doc('b', '中文片段')])],
  routes: ['translate' as const],
  models: [MODEL_A, MODEL_B] as [string, string],
  catalogIndex: null,
  target: TARGET,
  token: TOKEN,
  timeoutMs: 5000,
  concurrency: 1,
  ...overrides,
})

describe('inputCount', () => {
  // The rule `checkCall` takes as its third argument, exported so the readout
  // and the CLI's console summary cannot each spell it out and drift apart.
  it('counts the payload array an array route was sent', () => {
    expect(
      inputCount('batch-why', { query: 'q', passages: [{}, {}, {}] }),
    ).toBe(3)
    expect(inputCount('batch-relates', { query: 'q', docs: [{}, {}] })).toBe(2)
  })

  it('counts 1 for the single-output routes, whatever the request holds', () => {
    expect(inputCount('alignment', { query: 'q', resultsSummary: 's' })).toBe(1)
    expect(inputCount('translate', { text: '在测算新能源重卡' })).toBe(1)
  })

  it('counts 0 when the array is missing or unreadable, which fails the call', () => {
    expect(inputCount('batch-why', { passages: 'not an array' })).toBe(0)
    expect(inputCount('batch-relates', null)).toBe(0)
  })
})

describe('checkCall', () => {
  it('passes a well-formed success', () => {
    expect(checkCall(passing(), MODEL_A, 1)).toEqual({
      ok: true,
      failures: [],
    })
  })

  it('passes a well-formed array call', () => {
    const r = passing({
      route: 'batch-why',
      model: MODEL_B,
      response: {
        ok: true,
        explanations: [
          { why: 'why a', relation: 'direct' },
          { why: 'why b', relation: 'indirect' },
        ],
        provenance: { model: MODEL_B, produced: true },
      },
      provenance: { model: MODEL_B, produced: true },
    })

    expect(checkCall(r, MODEL_B, 2)).toEqual({ ok: true, failures: [] })
  })

  it('fails a call whose provenance.produced is false', () => {
    const r = passing({
      route: 'alignment',
      response: {
        ok: true,
        assessment: { insights: ['canned'], alignment: 'Moderate' },
        provenance: {
          model: MODEL_A,
          produced: false,
          fallback_reason: 'upstream_500',
        },
      },
      provenance: {
        model: MODEL_A,
        produced: false,
        fallback_reason: 'upstream_500',
      },
    })

    const result = checkCall(r, MODEL_A, 1)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toMatch(/not produced/)
    // The reason is what makes a repeated fallback diagnosable.
    expect(result.failures.join('\n')).toContain('upstream_500')
  })

  it('fails a call whose provenance.model does not equal the requested model', () => {
    const r = passing({
      response: { ok: true, translation: '译文' },
      provenance: { model: MODEL_B, produced: true },
    })

    const result = checkCall(r, MODEL_A, 1)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain(MODEL_B)
    expect(result.failures.join('\n')).toContain(MODEL_A)
  })

  it('fails a call that carries no provenance block', () => {
    const r = passing({ response: { ok: true, translation: '译文' } })
    delete (r as { provenance?: unknown }).provenance

    const result = checkCall(r, MODEL_A, 1)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toMatch(/no provenance/)
  })

  it('fails an array route whose output length does not match the input count', () => {
    const r = passing({
      route: 'batch-relates',
      response: {
        ok: true,
        results: [{ relates: 'only one', relation: 'direct' }],
        provenance: { model: MODEL_A, produced: true },
      },
      provenance: { model: MODEL_A, produced: true },
    })

    const result = checkCall(r, MODEL_A, 2)

    expect(result.ok).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatch(/expected 2/)
    expect(result.failures[0]).toMatch(/got 1/)
  })

  it('fails a response with none of the shape its route promises', () => {
    const r = passing({
      route: 'alignment',
      response: { ok: true, provenance: { model: MODEL_A, produced: true } },
      provenance: { model: MODEL_A, produced: true },
    })

    const result = checkCall(r, MODEL_A, 1)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toMatch(/assessment\.insights/)
  })

  it('fails an empty-text translate response', () => {
    const r = passing({
      response: {
        ok: true,
        translation: '   ',
        provenance: { model: MODEL_A, produced: true },
      },
      provenance: { model: MODEL_A, produced: true },
    })

    const result = checkCall(r, MODEL_A, 1)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toMatch(/empty/)
  })

  it('fails a call whose case had zero documents', () => {
    // Even a perfect-looking response is not a row here: with no input there
    // was nothing to reason over, so "produced" would be a claim about nothing.
    const result = checkCall(passing(), MODEL_A, 0)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toMatch(/zero documents/)
  })

  it('fails a call that recorded an error, whatever its body looks like', () => {
    const r = passing({
      response: { ok: false, error: 'invalid eval token' },
      error: 'HTTP 400: {"ok":false,"error":"invalid eval token"}',
    })

    const result = checkCall(r, MODEL_A, 1)

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('HTTP 400')
  })
})

describe('runSweep', () => {
  it('posts each payload with the model and the eval token to every route', async () => {
    const { fetchImpl, calls } = echoModelFetch()

    const out = await runSweep(
      sweepArgs({
        routes: ['batch-why', 'translate'],
        fetchImpl,
      }),
    )

    expect(calls.map((c) => c.url)).toEqual([
      `${TARGET}/api/batch-why`,
      `${TARGET}/api/batch-why`,
      `${TARGET}/api/translate`,
      `${TARGET}/api/translate`,
    ])
    for (const c of calls) {
      expect(c.init.method).toBe('POST')
      expect(c.init.headers).toEqual({
        'Content-Type': 'application/json',
        'x-eval-token': TOKEN,
      })
    }
    // The payloads are Task 8's; this pins that they are sent unchanged, with
    // the model added rather than replacing anything.
    const whyA = JSON.parse(String(calls[0].init.body))
    expect(whyA.model).toBe(MODEL_A)
    expect(whyA.mode).toBe('answer')
    expect(whyA.passages).toHaveLength(2)
    const whyB = JSON.parse(String(calls[1].init.body))
    expect(whyB.model).toBe(MODEL_B)
    // translate takes the first non-ASCII snippet, not the first snippet.
    expect(JSON.parse(String(calls[2].init.body)).text).toBe('中文片段')

    expect(out).toHaveLength(4)
    expect(out.map((r) => [r.route, r.model])).toEqual([
      ['batch-why', MODEL_A],
      ['batch-why', MODEL_B],
      ['translate', MODEL_A],
      ['translate', MODEL_B],
    ])
    expect(out.every((r) => r.error === undefined)).toBe(true)
    expect(out.every((r) => typeof r.latency_ms === 'number')).toBe(true)
    expect(out[0].provenance).toEqual({ model: MODEL_A, produced: true })
    // Every call is evidence on this fake deployment.
    expect(
      out.map((r) => checkCall(r, r.model, r.route === 'translate' ? 1 : 2)),
    ).toEqual([
      { ok: true, failures: [] },
      { ok: true, failures: [] },
      { ok: true, failures: [] },
      { ok: true, failures: [] },
    ])
  })

  it('skips a case whose retrieval returned no documents', async () => {
    const { fetchImpl, calls } = echoModelFetch()

    const out = await runSweep(
      sweepArgs({
        cases: [frozenCase('q-empty', []), frozenCase('q1', [doc('a', 'x')])],
        fetchImpl,
      }),
    )

    expect(out.map((r) => r.case_id)).toEqual(['q1', 'q1'])
    expect(calls).toHaveLength(2)
  })

  it('records a non-2xx as an error and does not retry with the default model', async () => {
    const calls: FetchCall[] = []
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({ ok: false, error: 'invalid eval token' }),
          ),
      })
    }) as unknown as typeof fetch

    const out = await runSweep(
      sweepArgs({ models: [MODEL_A, MODEL_A], fetchImpl }),
    )

    expect(calls).toHaveLength(2)
    expect(out).toHaveLength(2)
    for (const r of out) {
      expect(r.error).toContain('400')
      expect(r.error).toContain('invalid eval token')
      expect((r.response as any).error).toBe('invalid eval token')
    }
  })

  it('records a rejecting fetch as an error rather than throwing', async () => {
    const fetchImpl = (() =>
      Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch

    const out = await runSweep(sweepArgs({ fetchImpl }))

    expect(out).toHaveLength(2)
    expect(out.every((r) => r.error?.includes('ECONNREFUSED'))).toBe(true)
  })

  it('times out a call that exceeds timeoutMs and records an error, not a throw', async () => {
    // Never settles, and ignores the abort signal: the deadline has to hold on
    // its own, not only because the transport honours it.
    const fetchImpl = (() => new Promise(() => {})) as unknown as typeof fetch

    const out = await runSweep(sweepArgs({ timeoutMs: 10, fetchImpl }))

    expect(out).toHaveLength(2)
    expect(out.every((r) => r.error === 'timeout after 10ms')).toBe(true)
  })
})

describe('resolveCodeVersion', () => {
  const TASK_ARN = 'arn:aws:ecs:us-east-2:123456789012:task/askwri-qa/abc123'

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('returns the running task container imageDigest', async () => {
    ;(execFileSync as unknown as jest.Mock).mockImplementation(
      (_cmd: string, args: string[]) =>
        args[1] === 'list-tasks'
          ? JSON.stringify({ taskArns: [TASK_ARN] })
          : JSON.stringify({
              tasks: [
                {
                  containers: [{ name: 'app', imageDigest: 'sha256:deadbeef' }],
                },
              ],
            }),
    )

    expect(
      await resolveCodeVersion('askwri-qa', 'askwri-qa', 'us-east-2'),
    ).toBe('sha256:deadbeef')

    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      'aws',
      [
        'ecs',
        'list-tasks',
        '--cluster',
        'askwri-qa',
        '--service-name',
        'askwri-qa',
        '--desired-status',
        'RUNNING',
        '--region',
        'us-east-2',
        '--output',
        'json',
      ],
      expect.anything(),
    )
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      'aws',
      [
        'ecs',
        'describe-tasks',
        '--cluster',
        'askwri-qa',
        '--tasks',
        TASK_ARN,
        '--region',
        'us-east-2',
        '--output',
        'json',
      ],
      expect.anything(),
    )
  })

  it('returns null when the aws CLI is missing or unauthorised', async () => {
    ;(execFileSync as unknown as jest.Mock).mockImplementation(() => {
      throw new Error('spawn aws ENOENT')
    })

    expect(
      await resolveCodeVersion('askwri-qa', 'askwri-qa', 'us-east-2'),
    ).toBeNull()
  })

  it('returns null when the service has no running task', async () => {
    ;(execFileSync as unknown as jest.Mock).mockReturnValue(
      JSON.stringify({ taskArns: [] }),
    )

    expect(
      await resolveCodeVersion('askwri-qa', 'askwri-qa', 'us-east-2'),
    ).toBeNull()
    expect(execFileSync).toHaveBeenCalledTimes(1)
  })

  it('returns null when the container reports no image digest', async () => {
    ;(execFileSync as unknown as jest.Mock).mockImplementation(
      (_cmd: string, args: string[]) =>
        args[1] === 'list-tasks'
          ? JSON.stringify({ taskArns: [TASK_ARN] })
          : JSON.stringify({ tasks: [{ containers: [{ name: 'app' }] }] }),
    )

    expect(
      await resolveCodeVersion('askwri-qa', 'askwri-qa', 'us-east-2'),
    ).toBeNull()
  })
})
