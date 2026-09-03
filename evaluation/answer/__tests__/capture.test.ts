/** @jest-environment node */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { SYS_V1, SYS_V2 } from '@/app/api/answer/route'
import { parseControls } from '../cli'
import {
  PreflightAbortError,
  runCapture,
  writeCaptureArtifact,
} from '../capture'
import { fetchJson } from '../http'
import { Evalset } from '../types'
import { close, listen, readJsonBody, respondJson } from '../test-server'

const sha256 = (s: string) =>
  crypto.createHash('sha256').update(s).digest('hex')

const makeEvalset = (): Evalset => ({
  name: 'capture-test',
  version: '1',
  test_cases: [
    {
      id: 'q1',
      question: 'What about trucks?',
      review_status: 'expert_approved',
      retrieval_ground_truth: { expected_external_ids: ['doc_a'] },
      synthesis_ground_truth: { key_facts: ['f1'] },
    },
    {
      id: 'q2',
      question: 'Anything on hydrogen?',
      retrieval_ground_truth: { expected_external_ids: ['doc_b'] },
      synthesis_ground_truth: { key_facts: ['f2'] },
    },
  ],
})

/** The gateway doc the fake returns verbatim — the answer body must carry it. */
const FAKE_DOC = {
  doc_id: 'doc_a',
  title: 'Trucks',
  score: 0.9,
  kps: [
    {
      snippet: 'chunk text about trucks',
      passage_id: 'doc_a_chunk_1',
      page: 2,
    },
  ],
  meta: { raw: { chunk_id: 'doc_a_chunk_1' } },
}

interface FakeGateway {
  url: string
  server: http.Server
  retrievalCalls: any[]
  answerCalls: any[]
  answerStatusFor: (query: string) => number
  retrievalStatusFor: (query: string) => number
  /** Transport-level failure: destroy the socket instead of replying. */
  destroyAnswerFor: (query: string) => boolean
  catalog: string[]
}

/** Fake deployed app: catalog, retrieval, answer, health on 127.0.0.1. */
const openServers: http.Server[] = []

async function startFakeGateway(catalog: string[]): Promise<FakeGateway> {
  const gw: FakeGateway = {
    url: '',
    server: null as unknown as http.Server,
    retrievalCalls: [],
    answerCalls: [],
    answerStatusFor: () => 200,
    retrievalStatusFor: () => 200,
    destroyAnswerFor: () => false,
    catalog,
  }
  gw.server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/llamaindex') {
      respondJson(res, 200, {
        ok: true,
        service: 'LlamaIndex API Gateway (Hybrid)',
        hybrid_service: { status: 'healthy', retrieval_backend: 'postgres' },
      })
    } else if (req.method === 'GET' && req.url === '/api/catalog') {
      respondJson(res, 200, {
        ok: true,
        count: catalog.length,
        items: catalog.map((id) => ({ meta: { file_path: `${id}.pdf` } })),
      })
    } else if (req.method === 'POST' && req.url === '/api/llamaindex') {
      readJsonBody(req, (b) => {
        gw.retrievalCalls.push(b)
        if (gw.retrievalStatusFor(b.query) !== 200) {
          respondJson(res, gw.retrievalStatusFor(b.query), {
            ok: false,
            error: 'gateway exploded',
          })
          return
        }
        respondJson(res, 200, {
          ok: true,
          docs: [FAKE_DOC],
          likely_off_topic: b.query === 'Anything on hydrogen?',
          debug: { total_ms: 7 },
          usage: { total_usd: 0.01 },
        })
      })
    } else if (req.method === 'POST' && req.url === '/api/answer') {
      readJsonBody(req, (b) => {
        gw.answerCalls.push(b)
        if (gw.destroyAnswerFor(b.query)) {
          // Transport failure, not an HTTP error: kill the socket mid-run.
          req.socket.destroy()
          return
        }
        const status = gw.answerStatusFor(b.query)
        if (status === 200) {
          respondJson(res, 200, {
            ok: true,
            synthesis: {
              sentences: ['s one', 's two'],
              cites: [[1], [2]],
              source_relevance: [{ doc_id: 'doc_a', tier: 'strong' }],
            },
            passages_sent: [
              {
                id: 1,
                doc_id: 'doc_a',
                chunk_id: 'doc_a_chunk_1',
                page: 2,
                text: 'chunk text about trucks',
              },
            ],
            debug: {
              knobs: { model: 'fake-model', base_url: 'http://fake/v1' },
              invalid_cites: 1,
              marker: 'raw-preserved',
            },
          })
        } else {
          respondJson(res, status, { ok: false, error: 'synthesis exploded' })
        }
      })
    } else {
      respondJson(res, 404, { ok: false })
    }
  })
  gw.url = await listen(gw.server)
  // Registry teardown: a failed assertion skips the test's own close(),
  // and a still-listening server is exactly the handle that wedges jest's
  // exit (Task 2's lesson).
  openServers.push(gw.server)
  return gw
}

afterEach(async () => {
  while (openServers.length > 0) {
    await close(openServers.pop()!)
  }
})

const stubGit = (args: string[]) =>
  args.join(' ').includes('eval-review') ? 'fixturesha0000' : 'harnesssha0000'

const stubNow = () => new Date('2026-09-05T12:00:00Z')

function controlsFor(gwUrl: string, evalsetPath: string, ...extra: string[]) {
  return parseControls([evalsetPath, '--target', gwUrl, ...extra], 'capture')
}

function writeEvalsetTo(es: Evalset): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-'))
  const file = path.join(dir, 'capture-test.json')
  fs.writeFileSync(file, JSON.stringify(es))
  return file
}

describe('runCapture', () => {
  it('captures the full PassCapture shape for every case × pass, passing the gateway docs through verbatim', async () => {
    const gw = await startFakeGateway(['doc_a', 'doc_b'])
    const esPath = writeEvalsetTo(makeEvalset())
    const artifact = await runCapture(
      controlsFor(gw.url, esPath, '--passes', '2'),
      { http: fetchJson, git: stubGit, now: stubNow },
    )
    expect(artifact.schema).toBe('answer-eval/capture@1')
    expect(artifact.preflight.corpus_ok).toBe(true)
    expect(artifact.cases.map((c) => c.case_id)).toEqual(['q1', 'q2'])

    const c1 = artifact.cases[0]
    expect(c1.fixture_case.id).toBe('q1')
    expect(c1.passes).toHaveLength(2)
    expect(c1.passes.map((p) => p.pass)).toEqual([0, 1])

    const p = c1.passes[0]
    expect(p.retrieval).toEqual({
      chunks: [
        {
          rank: 1,
          doc_id: 'doc_a',
          chunk_id: 'doc_a_chunk_1',
          text: 'chunk text about trucks',
          score: 0.9,
        },
      ],
      likely_off_topic: false,
      service_ms: 7,
      cost_usd: 0.01,
      wall_ms: expect.any(Number),
    })
    // likely_off_topic flows from retrieval into the answer knobs (the
    // AIResearchModal mirror) unless the run overrode it.
    expect(p.answer.knobs).toEqual({ likely_off_topic: false })
    expect(p.answer.sentences).toEqual(['s one', 's two'])
    expect(p.answer.cites).toEqual([[1], [2]])
    expect(p.answer.cites).toHaveLength(p.answer.sentences.length)
    expect(p.answer.raw_model_json).toBeTruthy()
    expect(JSON.parse(p.answer.raw_model_json).marker).toBe('raw-preserved')
    expect(p.answer.source_relevance).toEqual([
      { doc_id: 'doc_a', tier: 'strong' },
    ])
    expect(p.answer.warning).toBeUndefined()
    expect(p.answer.low_coverage).toBe(false)
    expect(p.answer.invalid_cites).toBe(1)
    expect(p.answer.passages_sent).toEqual([
      {
        id: 1,
        doc_id: 'doc_a',
        chunk_id: 'doc_a_chunk_1',
        page: 2,
        text: 'chunk text about trucks',
      },
    ])
    expect(p.answer.wall_ms).toEqual(expect.any(Number))

    // Docs verbatim: the gateway's response docs reach the answer body
    // unchanged (plus the routed knobs).
    const q1Answer = gw.answerCalls.find(
      (b) => b.query === 'What about trucks?',
    )
    expect(q1Answer).toBeTruthy()
    expect(q1Answer.docs).toEqual([FAKE_DOC])

    // q2's retrieval flags likely_off_topic → its answer knobs carry it.
    const q2Answer = gw.answerCalls.find(
      (b) => b.query === 'Anything on hydrogen?',
    )
    expect(q2Answer.likely_off_topic).toBe(true)
    expect(artifact.cases[1].passes[0].answer.knobs).toEqual({
      likely_off_topic: true,
    })
    await close(gw.server)
  })

  it('routes --knob synthesis vs retrieval keys to the right request bodies, and errors on unknown keys at parse', async () => {
    const gw = await startFakeGateway(['doc_a', 'doc_b'])
    const esPath = writeEvalsetTo(makeEvalset())
    const artifact = await runCapture(
      controlsFor(
        gw.url,
        esPath,
        '--knob',
        'max_passages=12',
        '--knob',
        'dense_weight=0.8',
      ),
      { http: fetchJson, git: stubGit, now: stubNow },
    )
    expect(artifact.provenance.knobs).toEqual({
      retrieval: { dense_weight: 0.8 },
      synthesis: { max_passages: 12 },
    })
    const q1Answer = gw.answerCalls.find(
      (b) => b.query === 'What about trucks?',
    )
    expect(q1Answer.max_passages).toBe(12)
    const q1Retrieval = gw.retrievalCalls.find(
      (b) => b.query === 'What about trucks?',
    )
    expect(q1Retrieval.dense_weight).toBe(0.8)
    // Unknown knob → hard error at parse time (before any HTTP).
    expect(() => controlsFor(gw.url, esPath, '--knob', 'bogus_knob=1')).toThrow(
      /bogus_knob/,
    )
    await close(gw.server)
  })

  it('assembles provenance: fixture commit, harness SHA, prompt hashes, effective synthesis, target, passes, ISO timestamp', async () => {
    const gw = await startFakeGateway(['doc_a', 'doc_b'])
    const esPath = writeEvalsetTo(makeEvalset())
    const artifact = await runCapture(
      controlsFor(gw.url, esPath, '--passes', '2'),
      { http: fetchJson, git: stubGit, now: stubNow },
    )
    expect(artifact.provenance.fixture).toEqual({
      path: esPath,
      name: 'capture-test',
      commit: 'fixturesha0000',
    })
    expect(artifact.provenance.harness_sha).toBe('harnesssha0000')
    // Prompt hashes keyed by version, sha256 of the shipped prompt strings.
    expect(artifact.provenance.synthesis.prompt_hashes).toEqual({
      v1: sha256(SYS_V1),
      v2: sha256(SYS_V2),
    })
    // EFFECTIVE synthesis values from the first successful answer's debug.
    expect(artifact.provenance.synthesis.model).toBe('fake-model')
    expect(artifact.provenance.synthesis.base_url).toBe('http://fake/v1')
    expect(artifact.provenance.target).toEqual({
      mode: 'gateway',
      urls: [gw.url],
      config: { status: 'healthy', retrieval_backend: 'postgres' },
    })
    expect(artifact.provenance.passes).toBe(2)
    expect(artifact.provenance.timestamp).toBe('2026-09-05T12:00:00.000Z')
    expect(artifact.provenance.node_version).toBe(process.version)
    await close(gw.server)
  })

  it('falls back to the requested synthesis knobs when no answer succeeds', async () => {
    const gw = await startFakeGateway(['doc_a', 'doc_b'])
    // Probe (query 'ping') succeeds so preflight passes; every real answer 500s.
    gw.answerStatusFor = (q) => (q === 'ping' ? 200 : 500)
    const esPath = writeEvalsetTo(makeEvalset())
    const artifact = await runCapture(
      controlsFor(gw.url, esPath, '--knob', 'model=requested-model'),
      { http: fetchJson, git: stubGit, now: stubNow },
    )
    expect(artifact.provenance.synthesis.model).toBe('requested-model')
    await close(gw.server)
  })

  it('filters by --only, slices by --limit, and triples passes with --passes 3', async () => {
    const gw = await startFakeGateway(['doc_a', 'doc_b'])
    const esPath = writeEvalsetTo(makeEvalset())

    const only = await runCapture(controlsFor(gw.url, esPath, '--only', 'q2'), {
      http: fetchJson,
      git: stubGit,
      now: stubNow,
    })
    expect(only.cases.map((c) => c.case_id)).toEqual(['q2'])

    const limited = await runCapture(
      controlsFor(gw.url, esPath, '--limit', '1'),
      { http: fetchJson, git: stubGit, now: stubNow },
    )
    expect(limited.cases.map((c) => c.case_id)).toEqual(['q1'])

    gw.answerCalls.length = 0
    const tripled = await runCapture(
      controlsFor(gw.url, esPath, '--passes', '3'),
      { http: fetchJson, git: stubGit, now: stubNow },
    )
    expect(tripled.cases[0].passes).toHaveLength(3)
    const q1Answers = gw.answerCalls.filter(
      (b) => b.query === 'What about trucks?',
    )
    expect(q1Answers).toHaveLength(3)
    await close(gw.server)
  })

  it('records a failed answer per pass and continues with the other cases', async () => {
    const gw = await startFakeGateway(['doc_a', 'doc_b'])
    gw.answerStatusFor = (q) => (q === 'Anything on hydrogen?' ? 500 : 200)
    const esPath = writeEvalsetTo(makeEvalset())
    const artifact = await runCapture(controlsFor(gw.url, esPath), {
      http: fetchJson,
      git: stubGit,
      now: stubNow,
    })
    const q2 = artifact.cases.find((c) => c.case_id === 'q2')!
    expect(q2.passes[0].answer.error).toContain('synthesis exploded')
    expect(q2.passes[0].answer.sentences).toEqual([])
    const q1 = artifact.cases.find((c) => c.case_id === 'q1')!
    expect(q1.passes[0].answer.error).toBeUndefined()
    expect(q1.passes[0].answer.sentences).toEqual(['s one', 's two'])
    await close(gw.server)
  })

  it('survives a transport-level answer failure: the pass carries answer.error, the other cases complete, and the artifact is written', async () => {
    const gw = await startFakeGateway(['doc_a', 'doc_b'])
    // Destroy the socket on q2's answer — a transport throw (post-retry),
    // not a 500. fetchJson burns its one retry on the reset connection.
    gw.destroyAnswerFor = (q) => q === 'Anything on hydrogen?'
    const esPath = writeEvalsetTo(makeEvalset())
    const artifact = await runCapture(controlsFor(gw.url, esPath), {
      http: fetchJson,
      git: stubGit,
      now: stubNow,
    })
    const q2 = artifact.cases.find((c) => c.case_id === 'q2')!
    expect(q2.passes[0].answer.error).toContain('answer call failed')
    expect(q2.passes[0].answer.sentences).toEqual([])
    // The successful retrieval is preserved alongside the failed answer.
    expect(q2.passes[0].retrieval.error).toBeUndefined()
    expect(q2.passes[0].retrieval.chunks).toHaveLength(1)
    const q1 = artifact.cases.find((c) => c.case_id === 'q1')!
    expect(q1.passes[0].answer.error).toBeUndefined()
    expect(q1.passes[0].answer.sentences).toEqual(['s one', 's two'])
    // The run completed — the artifact writes instead of exiting 1.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-transport-'))
    const file = writeCaptureArtifact(dir, 'transport', artifact)
    expect(fs.existsSync(file)).toBe(true)
    await close(gw.server)
  })

  it('records a failed retrieval per pass and skips that pass answer', async () => {
    const gw = await startFakeGateway(['doc_a', 'doc_b'])
    gw.retrievalStatusFor = (q) => (q === 'Anything on hydrogen?' ? 500 : 200)
    const esPath = writeEvalsetTo(makeEvalset())
    const artifact = await runCapture(controlsFor(gw.url, esPath), {
      http: fetchJson,
      git: stubGit,
      now: stubNow,
    })
    const q2 = artifact.cases.find((c) => c.case_id === 'q2')!
    expect(q2.passes[0].retrieval.error).toContain('gateway exploded')
    expect(q2.passes[0].retrieval.chunks).toEqual([])
    expect(q2.passes[0].answer.error).toContain('retrieval failed')
    await close(gw.server)
  })

  it('prints the accumulated retrieval cost total and mean', async () => {
    const gw = await startFakeGateway(['doc_a', 'doc_b'])
    const esPath = writeEvalsetTo(makeEvalset())
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    let logged = ''
    try {
      // 1 case × 2 passes × $0.01 per retrieval.
      await runCapture(
        controlsFor(gw.url, esPath, '--only', 'q1', '--passes', '2'),
        {
          http: fetchJson,
          git: stubGit,
          now: stubNow,
        },
      )
      // Read before mockRestore() — restore clears mock.calls.
      logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    } finally {
      logSpy.mockRestore()
    }
    expect(logged).toContain('cost')
    expect(logged).toContain('$0.0200 total')
    expect(logged).toContain('$0.0100 mean')
    await close(gw.server)
  })

  it('aborts before any capture-pass call when preflight finds a missing corpus doc', async () => {
    const gw = await startFakeGateway(['doc_a']) // doc_b missing
    const esPath = writeEvalsetTo(makeEvalset())
    await expect(
      runCapture(controlsFor(gw.url, esPath), {
        http: fetchJson,
        git: stubGit,
        now: stubNow,
      }),
    ).rejects.toBeInstanceOf(PreflightAbortError)
    // The only answer traffic is the preflight synthesis probe ('ping').
    const realAnswers = gw.answerCalls.filter((b) => b.query !== 'ping')
    expect(realAnswers).toEqual([])
    expect(gw.retrievalCalls).toEqual([])
    await close(gw.server)
  })

  it('applies --limit before preflight: a missing doc in a LATER case neither aborts nor inflates the estimate', async () => {
    const gw = await startFakeGateway(['doc_a']) // doc_b (q2) missing
    const esPath = writeEvalsetTo(makeEvalset())
    const artifact = await runCapture(
      controlsFor(gw.url, esPath, '--limit', '1'),
      {
        http: fetchJson,
        git: stubGit,
        now: stubNow,
      },
    )
    // Preflight saw exactly the selected case (q1): gate passed, capture ran.
    expect(artifact.cases.map((c) => c.case_id)).toEqual(['q1'])
    expect(artifact.preflight.corpus_ok).toBe(true)
    expect(artifact.preflight.estimated_calls).toEqual({
      retrieval: 1,
      synthesis: 1,
      judge: 0,
    })
    const realAnswers = gw.answerCalls.filter((b) => b.query !== 'ping')
    expect(realAnswers).toHaveLength(1)
    expect(realAnswers[0].query).toBe('What about trucks?')
    await close(gw.server)
  })

  it('the abort message names the missing docs and the failing cases', async () => {
    const gw = await startFakeGateway(['doc_a']) // doc_b missing
    const esPath = writeEvalsetTo(makeEvalset())
    const errSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    let message = ''
    try {
      await runCapture(controlsFor(gw.url, esPath), {
        http: fetchJson,
        git: stubGit,
        now: stubNow,
      })
    } catch (e) {
      message = (e as Error).message
    } finally {
      errSpy.mockRestore()
    }
    expect(message).toContain('doc_b')
    expect(message).toContain('q2')
    expect(message).toContain('aborting')
    await close(gw.server)
  })

  it('lets an explicit likely_off_topic knob override the retrieval flag', async () => {
    const gw = await startFakeGateway(['doc_a', 'doc_b'])
    const esPath = writeEvalsetTo(makeEvalset())
    await runCapture(
      controlsFor(gw.url, esPath, '--knob', 'likely_off_topic=false'),
      { http: fetchJson, git: stubGit, now: stubNow },
    )
    const q2Answer = gw.answerCalls.find(
      (b) => b.query === 'Anything on hydrogen?',
    )
    expect(q2Answer.likely_off_topic).toBe(false)
    await close(gw.server)
  })
})

describe('writeCaptureArtifact', () => {
  it('writes a pretty artifact with stable bytes under artifacts/capture-<label>.json', async () => {
    const gw = await startFakeGateway(['doc_a', 'doc_b'])
    const esPath = writeEvalsetTo(makeEvalset())
    const artifact = await runCapture(
      controlsFor(gw.url, esPath, '--label', 'unit'),
      {
        http: fetchJson,
        git: stubGit,
        now: stubNow,
      },
    )
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-artifact-'))
    const file1 = writeCaptureArtifact(dir, 'unit', artifact)
    const file2 = writeCaptureArtifact(dir, 'unit', artifact)
    expect(path.basename(file1)).toBe('capture-unit.json')
    expect(fs.readFileSync(file1, 'utf8')).toBe(fs.readFileSync(file2, 'utf8'))
    const round = JSON.parse(fs.readFileSync(file1, 'utf8'))
    expect(round.schema).toBe('answer-eval/capture@1')
    expect(round.cases).toHaveLength(2)
    await close(gw.server)
  })
})
