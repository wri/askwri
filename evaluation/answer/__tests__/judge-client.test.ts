/** @jest-environment node */
import * as crypto from 'crypto'
import * as http from 'http'
import {
  JudgeAuthError,
  JudgeOk,
  JudgeUnjudged,
  judgeCall,
} from '../judge-client'
import {
  FACT_RECALL_SYSTEM,
  PROMPT_HASHES,
  SENTENCE_SUPPORT_SYSTEM,
  UNSUPPORTED_CLAIMS_SYSTEM,
  validateFactRecall,
  validateSentenceSupport,
  validateUnsupportedClaims,
} from '../judge-prompts'
import { close, listen, readJsonBody, respondJson } from '../test-server'

const sha256 = (s: string) =>
  crypto.createHash('sha256').update(s).digest('hex')

const SYSTEM = FACT_RECALL_SYSTEM
const USER = 'the user content'
const JUDGE_MODEL = 'glm-4.6'

const VALID_REPLY = JSON.stringify({
  verdicts: [
    { fact_index: 0, verdict: 'stated', evidence: 'quoted evidence' },
    { fact_index: 1, verdict: 'absent', evidence: 'nothing' },
  ],
})

const validate = (json: any) => validateFactRecall(json, 2)

interface ScriptedReply {
  status?: number
  content?: string
  delayMs?: number
}

interface ScriptedServer {
  requests: any[]
  server: http.Server
}

/** Fake judge provider on 127.0.0.1 with a scripted reply sequence. */
function startJudgeServer(script: ScriptedReply[]): ScriptedServer {
  const requests: any[] = []
  let n = 0
  const server = http.createServer((req, res) => {
    readJsonBody(req, (body) => {
      requests.push(body)
      const reply = script[Math.min(n, script.length - 1)]
      n++
      const respond = () => {
        respondJson(
          res,
          reply.status ?? 200,
          reply.content !== undefined
            ? {
                choices: [{ message: { content: reply.content } }],
                usage: { prompt_tokens: 11, completion_tokens: 7 },
              }
            : { error: { message: 'scripted failure' } },
        )
      }
      if (reply.delayMs) setTimeout(respond, reply.delayMs)
      else respond()
    })
  })
  return { requests, server }
}

interface RunResult {
  result: JudgeOk<unknown> | JudgeUnjudged | undefined
  thrown: unknown
  requests: any[]
  sleepCalls: number[]
  elapsedMs: number
}

/** Start the fake server, run one judgeCall against it, close it. */
async function runJudge(
  script: ScriptedReply[],
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> {
  const sleepCalls: number[] = []
  const { requests, server } = startJudgeServer(script)
  const url = await listen(server)
  const t0 = Date.now()
  let result: JudgeOk<unknown> | JudgeUnjudged | undefined
  let thrown: unknown
  try {
    result = await judgeCall({
      system: SYSTEM,
      user: USER,
      validate,
      judgeModel: JUDGE_MODEL,
      baseUrl: url,
      apiKey: 'test-key',
      timeoutMs: opts.timeoutMs,
      sleep: async (ms) => {
        sleepCalls.push(ms)
      },
    })
  } catch (e) {
    thrown = e
  } finally {
    await close(server)
  }
  return {
    result,
    thrown,
    requests,
    sleepCalls,
    elapsedMs: Date.now() - t0,
  }
}

describe('judgeCall', () => {
  it('returns the verdict with prompt_hash = sha256(system) and usage', async () => {
    const r = await runJudge([{ content: VALID_REPLY }])
    expect(r.thrown).toBeUndefined()
    expect(r.result!.ok).toBe(true)
    if (r.result!.ok) {
      expect(r.result!.verdict).toEqual([
        { fact_index: 0, verdict: 'stated', evidence: 'quoted evidence' },
        { fact_index: 1, verdict: 'absent', evidence: 'nothing' },
      ])
      expect(r.result!.prompt_hash).toBe(sha256(SYSTEM))
      expect(r.result!.judge_model).toBe(JUDGE_MODEL)
      expect(r.result!.usage).toEqual({
        prompt_tokens: 11,
        completion_tokens: 7,
      })
    }
    expect(r.requests).toHaveLength(1)
    expect(r.requests[0].model).toBe(JUDGE_MODEL)
    expect(r.requests[0].temperature).toBe(0)
    expect(r.requests[0].max_tokens).toBe(2000)
    expect(r.requests[0].messages).toEqual([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: USER },
    ])
  })

  it('retries once on invalid JSON, appending the validation error', async () => {
    const r = await runJudge([
      { content: 'not json {' },
      { content: VALID_REPLY },
    ])
    expect(r.result!.ok).toBe(true)
    expect(r.requests).toHaveLength(2)
    const msgs = r.requests[1].messages
    expect(msgs).toHaveLength(3)
    expect(msgs[2].role).toBe('user')
    expect(msgs[2].content).toContain('not json {')
    expect(msgs[2].content).toContain('That reply failed validation')
    expect(msgs[2].content).toContain('Reply with JSON only')
  })

  it('retries once on a validator failure (wrong enum)', async () => {
    const bad = JSON.stringify({
      verdicts: [
        { fact_index: 0, verdict: 'bogus', evidence: 'x' },
        { fact_index: 1, verdict: 'stated', evidence: 'x' },
      ],
    })
    const r = await runJudge([{ content: bad }, { content: VALID_REPLY }])
    expect(r.result!.ok).toBe(true)
    expect(r.requests[1].messages[2].content).toContain(
      'That reply failed validation',
    )
  })

  it('returns unjudged with raw kept when both replies fail validation', async () => {
    const r = await runJudge([
      { content: 'first bad' },
      { content: 'second bad' },
    ])
    expect(r.result!.ok).toBe(false)
    if (!r.result!.ok) {
      expect(r.result!.unjudged.reason).toBe('validation')
      expect(r.result!.unjudged.raw).toBe('second bad')
      expect(r.result!.prompt_hash).toBe(sha256(SYSTEM))
      expect(r.result!.judge_model).toBe(JUDGE_MODEL)
    }
    expect(r.requests).toHaveLength(2)
  })

  it('throws JudgeAuthError on 401 with no further calls', async () => {
    const r = await runJudge([{ status: 401 }, { content: VALID_REPLY }])
    expect(r.thrown).toBeInstanceOf(JudgeAuthError)
    expect(r.requests).toHaveLength(1)
  })

  it('backs off and retries on 429 (fake sleep, no real waits)', async () => {
    const t0 = Date.now()
    const r = await runJudge([
      { status: 429 },
      { status: 429 },
      { content: VALID_REPLY },
    ])
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(r.result!.ok).toBe(true)
    expect(r.requests).toHaveLength(3)
    expect(r.sleepCalls).toEqual([1000, 2000])
  })

  it('gives up after 5 rate-limited attempts', async () => {
    const r = await runJudge([{ status: 429 }])
    expect(r.result!.ok).toBe(false)
    if (!r.result!.ok) {
      expect(r.result!.unjudged.reason).toBe('rate_limited')
    }
    expect(r.requests).toHaveLength(5)
    expect(r.sleepCalls).toEqual([1000, 2000, 4000, 8000])
  })

  it('retries once after a timeout, then succeeds', async () => {
    const r = await runJudge(
      [{ content: VALID_REPLY, delayMs: 200 }, { content: VALID_REPLY }],
      { timeoutMs: 50 },
    )
    expect(r.result!.ok).toBe(true)
    expect(r.requests).toHaveLength(2)
    // the first attempt timed out (>= 50ms) but we never waited out the 200ms server delay
    expect(r.elapsedMs).toBeGreaterThanOrEqual(50)
    expect(r.elapsedMs).toBeLessThan(200)
  })

  it('returns unjudged timeout after two timeouts', async () => {
    const r = await runJudge([{ content: VALID_REPLY, delayMs: 200 }], {
      timeoutMs: 50,
    })
    expect(r.result!.ok).toBe(false)
    if (!r.result!.ok) {
      expect(r.result!.unjudged.reason).toBe('timeout')
    }
    expect(r.requests).toHaveLength(2)
    expect(r.elapsedMs).toBeLessThan(400)
  })

  it('retries once on a 5xx, then gives up as unjudged', async () => {
    const r = await runJudge([{ status: 500 }, { status: 503 }])
    expect(r.result!.ok).toBe(false)
    if (!r.result!.ok) {
      expect(r.result!.unjudged.reason).toBe('server_error')
    }
    expect(r.requests).toHaveLength(2)
  })

  it('retries once on a network error, then gives up as unjudged', async () => {
    // Server that accepts the first request then destroys the socket, so
    // fetch rejects (ECONNRESET) instead of returning a status.
    const requests: any[] = []
    const server = http.createServer((req, _res) => {
      readJsonBody(req, (body) => {
        requests.push(body)
        req.socket.destroy()
      })
    })
    const url = await listen(server)
    const sleepCalls: number[] = []
    let result: any
    try {
      result = await judgeCall({
        system: SYSTEM,
        user: USER,
        validate,
        judgeModel: JUDGE_MODEL,
        baseUrl: url,
        apiKey: 'test-key',
        sleep: async (ms) => {
          sleepCalls.push(ms)
        },
      })
    } finally {
      await close(server)
    }
    expect(result.ok).toBe(false)
    expect(result.unjudged.reason).toBe('network')
    expect(requests).toHaveLength(2)
  })
})

describe('PROMPT_HASHES', () => {
  it('hashes each system prompt with sha256', () => {
    expect(PROMPT_HASHES).toEqual({
      fact_recall: sha256(FACT_RECALL_SYSTEM),
      sentence_support: sha256(SENTENCE_SUPPORT_SYSTEM),
      unsupported_claims: sha256(UNSUPPORTED_CLAIMS_SYSTEM),
    })
  })
})

describe('prompt validators', () => {
  it('fact recall: happy path passes', () => {
    const v = validateFactRecall(JSON.parse(VALID_REPLY), 2)
    expect(v).not.toBeInstanceOf(Error)
  })

  it('fact recall: missing fact_index is rejected', () => {
    const v = validateFactRecall(
      { verdicts: [{ verdict: 'stated', evidence: 'x' }] },
      2,
    )
    expect(v).toBeInstanceOf(Error)
  })

  it('fact recall: incomplete index coverage is rejected', () => {
    const v = validateFactRecall(
      {
        verdicts: [{ fact_index: 0, verdict: 'stated', evidence: 'x' }],
      },
      2,
    )
    expect(v).toBeInstanceOf(Error)
  })

  it('fact recall: wrong enum is rejected', () => {
    const v = validateFactRecall(
      {
        verdicts: [
          { fact_index: 0, verdict: 'bogus', evidence: 'x' },
          { fact_index: 1, verdict: 'stated', evidence: 'x' },
        ],
      },
      2,
    )
    expect(v).toBeInstanceOf(Error)
  })

  it('sentence support: supported requires a non-empty span', () => {
    expect(
      validateSentenceSupport({ verdict: 'supported', span: 'quote' }),
    ).toEqual({ verdict: 'supported', span: 'quote' })
    expect(
      validateSentenceSupport({ verdict: 'supported', span: '' }),
    ).toBeInstanceOf(Error)
    expect(
      validateSentenceSupport({ verdict: 'nope', span: 'quote' }),
    ).toBeInstanceOf(Error)
    expect(
      validateSentenceSupport({ verdict: 'unsupported', span: '' }),
    ).toEqual({ verdict: 'unsupported', span: '' })
  })

  it('unsupported claims: out-of-range indices and non-string reasons rejected', () => {
    expect(
      validateUnsupportedClaims(
        { unsupported_sentence_indices: [0, 1], reasons: ['r'] },
        2,
      ),
    ).toEqual({ unsupported_sentence_indices: [0, 1], reasons: ['r'] })
    expect(
      validateUnsupportedClaims(
        { unsupported_sentence_indices: [2], reasons: ['r'] },
        2,
      ),
    ).toBeInstanceOf(Error)
    expect(
      validateUnsupportedClaims(
        { unsupported_sentence_indices: [0], reasons: [7] },
        2,
      ),
    ).toBeInstanceOf(Error)
  })
})
