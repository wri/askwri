/** @jest-environment node */
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { captureFingerprint, runJudge } from '../judge'
import { JudgeAuthError } from '../judge-client'
import { FACT_RECALL_SYSTEM, PROMPT_HASHES } from '../judge-prompts'
import {
  CaptureArtifact,
  CaseCapture,
  FactRecallVerdicts,
  JudgedArtifact,
  PassageSent,
  Provenance,
  SentenceSupportVerdict,
} from '../types'
import { close, listen, readJsonBody, respondJson } from '../test-server'

const JUDGE_MODEL = 'glm-test'

const makeProvenance = (): Provenance => ({
  fixture: { path: 'evalset.json', name: 'judge-test', commit: 'fixturesha' },
  target: { mode: 'gateway', urls: ['http://target'], config: null },
  knobs: { retrieval: {}, synthesis: {} },
  synthesis: { model: 'synth', base_url: 'http://synth', prompt_hashes: {} },
  passes: 2,
  harness_sha: 'harnesssha',
  timestamp: '2026-09-05T12:00:00Z',
  node_version: process.version,
})

const makePassages = (): PassageSent[] => [
  { id: 1, doc_id: 'doc_zh', chunk_id: 'c1', page: 1, text: '中文段落内容' },
  {
    id: 2,
    doc_id: 'doc_en',
    chunk_id: 'c2',
    page: 3,
    text: 'english chunk text',
  },
]

/** 2 passes; sentence 1 has zero cites → no sentence_support item. */
const makeCase = (id: string, keyFacts?: string[]): CaseCapture => ({
  case_id: id,
  fixture_case: {
    id,
    question: `question ${id}`,
    ...(keyFacts ? { synthesis_ground_truth: { key_facts: keyFacts } } : {}),
  },
  passes: [0, 1].map((pass) => ({
    pass,
    retrieval: {
      chunks: [
        {
          rank: 1,
          doc_id: 'doc_en',
          chunk_id: 'c2',
          text: 'retrieved chunk text',
          score: 0.9,
        },
      ],
      likely_off_topic: false,
      service_ms: 1,
      cost_usd: null,
      wall_ms: 1,
    },
    answer: {
      knobs: {},
      passages_sent: makePassages(),
      sentences: ['sentence zero', 'sentence one', 'sentence two'],
      cites: [[1], [], [1, 2]],
      raw_model_json: '{}',
      low_coverage: false,
      invalid_cites: 0,
      wall_ms: 1,
    },
  })),
})

const makeCapture = (cases: CaseCapture[]): CaptureArtifact => ({
  schema: 'answer-eval/capture@1',
  provenance: makeProvenance(),
  preflight: {
    corpus_ok: true,
    missing_docs: [],
    snippet_failures: [],
    twins_ok: true,
    synthesis_probe_ok: true,
    judge_probe_ok: true,
    approved: 1,
    draft: 0,
    rejected: 0,
    estimated_calls: { retrieval: 0, synthesis: 0, judge: 0 },
  },
  cases,
})

const expectedKeys = (caseId: string, withFacts: boolean): string[] => {
  const keys: string[] = []
  for (const pass of [0, 1]) {
    if (withFacts) keys.push(`${caseId}|${pass}|fact_recall:`)
    keys.push(`${caseId}|${pass}|sentence_support:0`)
    keys.push(`${caseId}|${pass}|sentence_support:2`)
    keys.push(`${caseId}|${pass}|unsupported_claims:`)
  }
  return keys
}

interface JudgeServer {
  url: string
  requests: any[]
}

const openServers: http.Server[] = []

/** Fake judge provider on 127.0.0.1 that replies validly by prompt kind. */
async function startJudgeServer(
  opts: { status401From?: number } = {},
): Promise<JudgeServer> {
  const requests: any[] = []
  let n = 0
  const server = http.createServer((req, res) => {
    readJsonBody(req, (body) => {
      requests.push(body)
      const i = n++
      if (opts.status401From !== undefined && i >= opts.status401From) {
        respondJson(res, 401, { error: { message: 'bad key' } })
        return
      }
      const system = body.messages.find((m: any) => m.role === 'system').content
      const user = body.messages.find((m: any) => m.role === 'user').content
      let content: string
      if (system === FACT_RECALL_SYSTEM) {
        const factCount = (user.match(/^\[\d+\] /gm) ?? []).length
        content = JSON.stringify({
          verdicts: Array.from({ length: factCount }, (_, k) => ({
            fact_index: k,
            verdict: 'stated',
            evidence: 'quoted evidence',
          })),
        })
      } else if (user.startsWith('Answer sentence:')) {
        content = JSON.stringify({ verdict: 'supported', span: 'passage span' })
      } else {
        content = JSON.stringify({
          unsupported_sentence_indices: [],
          reasons: [],
        })
      }
      respondJson(res, 200, {
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })
    })
  })
  const url = await listen(server)
  // Registry teardown + env: runJudge resolves the API key through
  // resolveProvider, so the fake URL must be the configured lunaroute URL.
  openServers.push(server)
  process.env.LUNAROUTE_BASE_URL = url
  process.env.LUNAROUTE_API_KEY = 'test-key'
  return { url, requests }
}

const ENV_KEYS = [
  'LUNAROUTE_BASE_URL',
  'LUNAROUTE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
]
const savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
})
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  while (openServers.length > 0) await close(openServers.pop()!)
})

function silenceConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = []
  const push = (...a: unknown[]) => logs.push(a.join(' '))
  const log = jest.spyOn(console, 'log').mockImplementation(push)
  const err = jest.spyOn(console, 'error').mockImplementation(push)
  return {
    logs,
    restore: () => {
      log.mockRestore()
      err.mockRestore()
    },
  }
}

const judgedPathIn = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-test-'))
  return path.join(dir, 'judged-test.json')
}

const runFull = async (
  s: JudgeServer,
  file: string,
  capture: CaptureArtifact,
  extra: { only?: string[]; judgeModel?: string } = {},
) =>
  runJudge({
    capture,
    judgedPath: file,
    judgeModel: JUDGE_MODEL,
    judgeBaseUrl: s.url,
    ...extra,
  })

const runOn = async (
  s: JudgeServer,
  file: string,
  capture: CaptureArtifact,
  extra: { only?: string[]; judgeModel?: string } = {},
) => (await runFull(s, file, capture, extra)).artifact

describe('runJudge', () => {
  it('judges the full item set per case × pass (zero-cite sentence excluded), with prompt_hash + judge_model on every verdict', async () => {
    const s = await startJudgeServer()
    const file = judgedPathIn()
    const c = silenceConsole()
    let artifact
    try {
      artifact = await runOn(
        s,
        file,
        makeCapture([makeCase('q1', ['fact one', 'fact two'])]),
      )
    } finally {
      c.restore()
    }
    expect(Object.keys(artifact.items).sort()).toEqual(expectedKeys('q1', true))
    expect(s.requests).toHaveLength(8)

    const fact = artifact.items['q1|0|fact_recall:'] as FactRecallVerdicts
    expect(fact.verdicts).toEqual([
      { fact_index: 0, verdict: 'stated', evidence: 'quoted evidence' },
      { fact_index: 1, verdict: 'stated', evidence: 'quoted evidence' },
    ])
    expect(fact.prompt_hash).toBe(PROMPT_HASHES.fact_recall)
    expect(fact.judge_model).toBe(JUDGE_MODEL)

    const ss = artifact.items[
      'q1|1|sentence_support:2'
    ] as SentenceSupportVerdict
    expect(ss.sentence_index).toBe(2)
    expect(ss.verdict).toBe('supported')
    expect(ss.span).toBe('passage span')
    expect(ss.prompt_hash).toBe(PROMPT_HASHES.sentence_support)
    expect(ss.judge_model).toBe(JUDGE_MODEL)

    // sentence_support inputs: the sentence + ONLY its cited passages,
    // each language-tagged (zh text presented as-is).
    const ssReq = s.requests.find(
      (r) =>
        r.messages[1].content.startsWith('Answer sentence:') &&
        r.messages[1].content.includes('sentence two'),
    )
    expect(ssReq).toBeTruthy()
    expect(ssReq.messages[1].content).toContain('(zh): 中文段落内容')
    expect(ssReq.messages[1].content).toContain('(latin): english chunk text')
    expect(ssReq.messages[1].content).not.toContain('sentence one')

    // unsupported_claims inputs: numbered sentences + full retrieved chunks.
    const ucReq = s.requests.find((r) =>
      r.messages[1].content.startsWith('Answer sentences:'),
    )
    expect(ucReq).toBeTruthy()
    expect(ucReq.messages[1].content).toContain('[0] sentence zero')
    expect(ucReq.messages[1].content).toContain('retrieved chunk text')

    // The file on disk matches the returned artifact.
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(artifact)

    // Usage totals are persisted on the judged artifact, not just printed
    // (8 calls × 10 prompt / 4 completion tokens).
    expect(artifact.usage).toEqual({
      prompt_tokens: 80,
      completion_tokens: 32,
      calls: 8,
    })

    // Usage totals printed (8 calls × 10 prompt / 4 completion tokens).
    expect(
      c.logs.some(
        (l) => l.includes('80 prompt') && l.includes('32 completion'),
      ),
    ).toBe(true)
  })

  it('skips fact_recall when the case has no key facts; --only filters cases and rejects unknown ids', async () => {
    const s = await startJudgeServer()
    const file = judgedPathIn()
    const c = silenceConsole()
    let artifact
    try {
      artifact = await runOn(
        s,
        file,
        makeCapture([makeCase('q1', ['f']), makeCase('q2')]),
        { only: ['q2'] },
      )
    } finally {
      c.restore()
    }
    expect(Object.keys(artifact.items).sort()).toEqual(
      expectedKeys('q2', false),
    )
    expect(s.requests).toHaveLength(6)

    await expect(
      runOn(s, file, makeCapture([makeCase('q1')]), { only: ['nope'] }),
    ).rejects.toThrow(/nope/)
  })

  it('spends no judge calls on answer-error passes (the scorer excludes them from every mean)', async () => {
    const s = await startJudgeServer()
    const file = judgedPathIn()
    const c = makeCase('q1', ['f1'])
    c.passes[1].answer.error = 'answer call failed: fetch failed'
    const c2 = silenceConsole()
    let artifact
    try {
      artifact = await runOn(s, file, makeCapture([c]))
    } finally {
      c2.restore()
    }
    // Only pass 0's items exist — pass 1 emitted no fact_recall,
    // sentence_support, or unsupported_claims job.
    expect(Object.keys(artifact.items).sort()).toEqual([
      'q1|0|fact_recall:',
      'q1|0|sentence_support:0',
      'q1|0|sentence_support:2',
      'q1|0|unsupported_claims:',
    ])
    expect(s.requests).toHaveLength(4)
  })

  it('resumes: pre-judged items (same capture, same judge, same prompt) are skipped, only missing items hit the server', async () => {
    const s = await startJudgeServer()
    const file = judgedPathIn()
    const capture = makeCapture([makeCase('q1', ['f1'])])
    const prior: JudgedArtifact = {
      schema: 'answer-eval/judged@1',
      provenance: makeProvenance(),
      capture_fingerprint: captureFingerprint(capture),
      usage: { prompt_tokens: 10, completion_tokens: 4, calls: 1 },
      items: {
        'q1|0|fact_recall:': {
          kind: 'fact_recall',
          prompt_hash: PROMPT_HASHES.fact_recall,
          judge_model: JUDGE_MODEL,
          verdicts: [
            { fact_index: 0, verdict: 'absent', evidence: 'prior evidence' },
          ],
        },
        'q1|0|sentence_support:0': {
          kind: 'sentence_support',
          sentence_index: 0,
          verdict: 'unsupported',
          span: '',
          prompt_hash: PROMPT_HASHES.sentence_support,
          judge_model: JUDGE_MODEL,
        },
      },
    }
    fs.writeFileSync(file, JSON.stringify(prior))
    const c = silenceConsole()
    let artifact
    try {
      artifact = await runOn(s, file, capture)
    } finally {
      c.restore()
    }
    expect(s.requests).toHaveLength(6)
    expect(Object.keys(artifact.items)).toHaveLength(8)
    expect(artifact.capture_fingerprint).toBe(captureFingerprint(capture))
    // Prior verdicts preserved verbatim.
    expect(
      (artifact.items['q1|0|fact_recall:'] as FactRecallVerdicts).verdicts[0]
        .evidence,
    ).toBe('prior evidence')
    // Usage accumulates across the resume: prior 1 call + this run's 6.
    expect(artifact.usage).toEqual({
      prompt_tokens: 70,
      completion_tokens: 28,
      calls: 7,
    })
  })

  it('refuses to resume a judged artifact that judged a DIFFERENT capture (same label, re-captured)', async () => {
    const s = await startJudgeServer()
    const file = judgedPathIn()
    const oldCapture = makeCapture([makeCase('q1', ['f1'])])
    oldCapture.cases[0].passes[0].answer.sentences = ['old answer']
    const prior: JudgedArtifact = {
      schema: 'answer-eval/judged@1',
      provenance: makeProvenance(),
      capture_fingerprint: captureFingerprint(oldCapture),
      items: {},
    }
    fs.writeFileSync(file, JSON.stringify(prior))
    await expect(
      runOn(s, file, makeCapture([makeCase('q1', ['f1'])])),
    ).rejects.toThrow(/different capture/)
    expect(s.requests).toHaveLength(0)
  })

  it('re-judges items whose judge model or prompt hash differ from this run (never mixes judges in one artifact)', async () => {
    const s = await startJudgeServer()
    const file = judgedPathIn()
    const capture = makeCapture([makeCase('q1', ['f1'])])
    const prior: JudgedArtifact = {
      schema: 'answer-eval/judged@1',
      provenance: makeProvenance(),
      capture_fingerprint: captureFingerprint(capture),
      items: {
        'q1|0|fact_recall:': {
          kind: 'fact_recall',
          prompt_hash: PROMPT_HASHES.fact_recall,
          judge_model: 'other-judge',
          verdicts: [{ fact_index: 0, verdict: 'absent', evidence: 'old' }],
        },
        'q1|0|sentence_support:0': {
          kind: 'sentence_support',
          sentence_index: 0,
          verdict: 'unsupported',
          span: '',
          prompt_hash: 'stale-prompt-hash',
          judge_model: JUDGE_MODEL,
        },
      },
    }
    fs.writeFileSync(file, JSON.stringify(prior))
    const c = silenceConsole()
    let artifact
    try {
      artifact = await runOn(s, file, capture)
    } finally {
      c.restore()
    }
    // Both stale items were re-judged: all 8 jobs hit the server.
    expect(s.requests).toHaveLength(8)
    expect(artifact.items['q1|0|fact_recall:'].judge_model).toBe(JUDGE_MODEL)
    expect(artifact.items['q1|0|sentence_support:0'].prompt_hash).toBe(
      PROMPT_HASHES.sentence_support,
    )
  })

  it('reports the run: pending count up front, ok/unjudged totals with reasons at the end', async () => {
    const s = await startJudgeServer()
    const file = judgedPathIn()
    const c = silenceConsole()
    let run
    try {
      run = await runFull(s, file, makeCapture([makeCase('q1', ['f1'])]))
    } finally {
      c.restore()
    }
    expect(run.judged).toBe(8)
    expect(run.unjudged).toBe(0)
    expect(run.reasons).toEqual({})
    expect(c.logs.some((l) => l.includes('8 item(s) to judge'))).toBe(true)
    expect(c.logs.some((l) => l.includes('8 ok, 0 unjudged'))).toBe(true)
  })

  it('retries an unjudged item left by an aborted run', async () => {
    const s = await startJudgeServer()
    const file = judgedPathIn()
    const capture = makeCapture([makeCase('q1', ['f1'])])
    const prior: JudgedArtifact = {
      schema: 'answer-eval/judged@1',
      provenance: makeProvenance(),
      capture_fingerprint: captureFingerprint(capture),
      items: {
        // Tombstone from an aborted run — must be retried.
        'q1|0|fact_recall:': {
          kind: 'fact_recall',
          prompt_hash: 'prior',
          judge_model: 'prior-model',
          unjudged: { reason: 'validation', raw: 'garbage' },
        } as unknown as FactRecallVerdicts,
      },
    }
    fs.writeFileSync(file, JSON.stringify(prior))
    const c = silenceConsole()
    let artifact
    try {
      artifact = await runOn(s, file, capture)
    } finally {
      c.restore()
    }
    expect(s.requests).toHaveLength(8)
    expect(artifact.items['q1|0|fact_recall:'].unjudged).toBeUndefined()
    expect(
      (artifact.items['q1|0|fact_recall:'] as FactRecallVerdicts).verdicts,
    ).toHaveLength(1)
  })

  it('aborts on judge 401 after persisting the partial artifact', async () => {
    const s = await startJudgeServer({ status401From: 3 })
    const file = judgedPathIn()
    const c = silenceConsole()
    let thrown: unknown
    try {
      await runOn(s, file, makeCapture([makeCase('q1', ['f1'])]))
    } catch (e) {
      thrown = e
    } finally {
      c.restore()
    }
    expect(thrown).toBeInstanceOf(JudgeAuthError)
    // Items 0-2 judged; the 4th request got the 401 and nothing after ran.
    expect(s.requests).toHaveLength(4)
    expect(fs.existsSync(file)).toBe(true)
    const partial = JSON.parse(fs.readFileSync(file, 'utf8')) as JudgedArtifact
    expect(Object.keys(partial.items).sort()).toEqual([
      'q1|0|fact_recall:',
      'q1|0|sentence_support:0',
      'q1|0|sentence_support:2',
    ])
    expect(c.logs.some((l) => l.includes('401'))).toBe(true)
  })

  it('provenance copies the capture and adds the judge block', async () => {
    const s = await startJudgeServer()
    const file = judgedPathIn()
    const c = silenceConsole()
    let artifact
    try {
      artifact = await runOn(s, file, makeCapture([makeCase('q1', ['f1'])]))
    } finally {
      c.restore()
    }
    expect(artifact.schema).toBe('answer-eval/judged@1')
    expect(artifact.provenance.judge).toEqual({
      model: JUDGE_MODEL,
      base_url: s.url,
      prompt_hashes: PROMPT_HASHES,
    })
    expect(artifact.provenance.harness_sha).toBe('harnesssha')
    expect(artifact.provenance.synthesis.model).toBe('synth')
  })
})
