/** @jest-environment node */
import * as http from 'http'
import { fetchJson } from '../http'
import { preflight } from '../preflight'
import { gatewayTarget } from '../target'
import { Evalset } from '../types'
import { close, listen, readJsonBody, respondJson } from '../test-server'

const CHUNK_TEXT =
  'The projected market penetration rate reaches forty percent by 2035.'

// 2-case fixture: case1 approved with a twin'd expected doc and a passage
// snippet resolvable against CHUNK_TEXT; case2 draft with no passage truth.
const evalset: Evalset = {
  name: 'preflight-test',
  test_cases: [
    {
      id: 'case1',
      question: 'What is the projected market penetration rate?',
      review_status: 'expert_approved',
      retrieval_ground_truth: {
        expected_external_ids: ['doc_a'],
        expected_passages: [
          {
            doc_id: 'doc_a',
            chunk_id: 'doc_a_chunk_1',
            page: 1,
            text_snippet: 'market penetration rate reaches forty percent',
          },
        ],
      },
      synthesis_ground_truth: {
        canonical_answer: 'First sentence. Second sentence.',
        key_facts: ['f1'],
      },
    },
    {
      id: 'case2',
      question: 'Anything about charging infrastructure?',
      retrieval_ground_truth: { expected_external_ids: ['doc_c'] },
      synthesis_ground_truth: { key_facts: ['f2'] },
    },
  ],
  twins: [['doc_a', 'doc_twin']],
}

interface FakeApp {
  url: string
  server: http.Server
  retrievalCalls: any[]
  answerCalls: any[]
  chunkTexts: string[]
  answerStatus: number
  /** When set, /api/answer replies ok:true with the route's fallback shape. */
  answerFallback?: string
  /** usage.total_usd reported on every retrieval call (null = none). */
  retrievalUsd: number | null
  /** When set, overrides chunkTexts per retrieval request (keyed on the
   * body — the existence-lookup tests answer differently for the case
   * question vs a snippet-derived query). */
  onRetrieval?: (body: any) => string[]
}

// Registry teardown: a failed assertion skips the test's own close(), and a
// still-listening server with idle keep-alive sockets wedges jest's exit.
const openServers: http.Server[] = []
afterEach(async () => {
  while (openServers.length > 0) await close(openServers.pop()!)
})

/** Fake deployed app: /api/catalog, /api/llamaindex, /api/answer on 127.0.0.1. */
async function startFakeApp(catalog: string[]): Promise<FakeApp> {
  const app: FakeApp = {
    url: '',
    server: null as unknown as http.Server,
    retrievalCalls: [],
    answerCalls: [],
    chunkTexts: [CHUNK_TEXT],
    answerStatus: 200,
    retrievalUsd: null,
  }
  app.server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/catalog') {
      respondJson(res, 200, {
        ok: true,
        count: catalog.length,
        items: catalog.map((id) => ({ meta: { file_path: `${id}.pdf` } })),
      })
    } else if (req.method === 'POST' && req.url === '/api/llamaindex') {
      readJsonBody(req, (b) => {
        app.retrievalCalls.push(b)
        const texts = app.onRetrieval ? app.onRetrieval(b) : app.chunkTexts
        respondJson(res, 200, {
          ok: true,
          docs: texts.map((text, i) => ({
            doc_id: (b.cite_doc_ids ?? [])[0] ?? 'doc',
            score: 1 - i * 0.1,
            kps: [{ snippet: text }],
            meta: { raw: { chunk_id: `chunk_${i}` } },
          })),
          likely_off_topic: false,
          debug: { total_ms: 1 },
          usage:
            app.retrievalUsd === null ? null : { total_usd: app.retrievalUsd },
        })
      })
    } else if (req.method === 'POST' && req.url === '/api/answer') {
      readJsonBody(req, (b) => {
        app.answerCalls.push(b)
        if (app.answerFallback) {
          // route.ts fallback: HTTP 200, ok:true, canned text, no cites.
          respondJson(res, 200, {
            ok: true,
            synthesis: {
              sentences: ['Answer synthesis is temporarily unavailable.'],
              cites: [[]],
            },
            passages_sent: [],
            debug: { fallbackReason: app.answerFallback },
          })
        } else if (app.answerStatus === 200) {
          respondJson(res, 200, {
            ok: true,
            synthesis: { sentences: ['probe ok'], cites: [[]] },
            passages_sent: [],
            debug: { knobs: { model: 'gpt-5.4' } },
          })
        } else {
          respondJson(res, app.answerStatus, {
            ok: false,
            error: 'Unsupported provider base_url: https://bad.example/v1',
          })
        }
      })
    } else {
      respondJson(res, 404, { ok: false })
    }
  })
  app.url = await listen(app.server)
  openServers.push(app.server)
  return app
}

/** Fake judge provider: POST /chat/completions. */
async function startFakeJudge(
  status: number,
): Promise<{ url: string; server: http.Server; calls: any[] }> {
  const calls: any[] = []
  const server = http.createServer((req, res) => {
    expect(req.url).toBe('/chat/completions')
    readJsonBody(req, (b) => {
      calls.push(b)
      if (status === 200) {
        respondJson(res, 200, { choices: [{ message: { content: 'pong' } }] })
      } else {
        respondJson(res, status, { error: { message: 'bad key' } })
      }
    })
  })
  const url = await listen(server)
  openServers.push(server)
  return { url, server, calls }
}

describe('preflight', () => {
  it('happy path: all checks pass, probes run, estimate exact for 2 cases × 2 passes', async () => {
    const app = await startFakeApp(['doc_a', 'doc_twin', 'doc_c'])
    const judge = await startFakeJudge(200)
    const target = gatewayTarget(app.url, fetchJson)
    const report = await preflight({
      evalset,
      target,
      judgeCfg: { model: 'judge-model', baseUrl: judge.url, apiKey: 'k' },
      passes: 2,
    })
    expect(report).toMatchObject({
      corpus_ok: true,
      missing_docs: [],
      snippet_failures: [],
      twins_ok: true,
      synthesis_probe_ok: true,
      judge_probe_ok: true,
      approved: 1,
      draft: 1,
      rejected: 0,
      // 2 cases × 2 passes retrieval/synthesis; judge = 2×(1+2+1) + 2×(1+3+1)
      estimated_calls: { retrieval: 4, synthesis: 4, judge: 18 },
    })
    // Snippet validation: one cite_doc_ids retrieval for case1's doc_a, with
    // the reranker OFF (its top_n and per-doc cap would truncate the doc's
    // chunk list — and they are the knobs the sweeps flip) and every pool
    // widened so the doc's chunks all return.
    expect(app.retrievalCalls).toEqual([
      {
        query: 'What is the projected market penetration rate?',
        mode: 'answer',
        cite_doc_ids: ['doc_a'],
        rerank: false,
        vector_top_k: 300,
        bm25_top_k: 300,
        fusion_top_k: 300,
        max_results: 300,
      },
    ])
    // Synthesis probe: minimal ping with capped knobs.
    expect(app.answerCalls).toHaveLength(1)
    expect(app.answerCalls[0]).toMatchObject({
      query: 'ping',
      max_passages: 1,
      passage_chars: 50,
    })
    // Judge probe: max_tokens 1 ping against the judge's model.
    expect(judge.calls).toEqual([
      {
        model: 'judge-model',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      },
    ])
    await close(app.server)
    await close(judge.server)
  })

  it('existence gate: a stop-word-dominated head query falls back to the mid-window query (2026-09-09 EN-twin case)', async () => {
    const app = await startFakeApp(['doc_a'])
    // A snippet whose head is boilerplate ("The key findings are as
    // follows:") and whose middle carries the content. The head query
    // returns nothing; the mid-window query must recover the chunk.
    const HEAD =
      'The key findings are as follows: First, without policy incentives, '
    const MID =
      'regional delivery would see a modest ZET market share by 2035, while '
    const TAIL = 'long-haul remains out of reach without stronger support.'
    const SNIPPET = HEAD + MID + TAIL
    const cps = Array.from(SNIPPET)
    const start = Math.max(0, Math.floor(cps.length / 2) - 24)
    const MID_QUERY = cps.slice(start, start + 48).join('')
    const seen: string[] = []
    app.onRetrieval = (b) => {
      seen.push(b.query)
      // The question lookup and the head-48 lookup both miss.
      if (b.query === MID_QUERY) return [SNIPPET]
      return []
    }
    const enEvalset: Evalset = {
      ...evalset,
      test_cases: [
        {
          ...evalset.test_cases[0],
          retrieval_ground_truth: {
            expected_external_ids: ['doc_a'],
            expected_passages: [
              {
                doc_id: 'doc_a',
                chunk_id: 'doc_a_chunk_7',
                page: 3,
                text_snippet: SNIPPET,
              },
            ],
          },
        },
        evalset.test_cases[1],
      ],
    }
    const target = gatewayTarget(app.url, fetchJson)
    const report = await preflight({ evalset: enEvalset, target, passes: 1 })
    expect(report.snippet_failures).toEqual([])
    // Head query was tried and returned nothing, then the mid window fired.
    expect(seen).toContain(MID_QUERY)
    // No rank gap here: the question lookup missed, so the gate ran — and
    // existence was proven by the fallback (rank-gap accounting is per
    // question-miss, which this is: recorded).
    expect(report.rank_gaps).toEqual([
      { case_id: 'case1', doc_id: 'doc_a', snippet_index: 0 },
    ])
  })

  it("synthesis probe carries the run's provider knobs (model, base_url, prompt_version) but keeps its own size caps", async () => {
    const app = await startFakeApp(['doc_a', 'doc_twin', 'doc_c'])
    const target = gatewayTarget(app.url, fetchJson)
    const report = await preflight({
      evalset,
      target,
      passes: 1,
      synthesisKnobs: {
        model: 'candidate-model',
        base_url: 'http://candidate/v1',
        prompt_version: 'v1',
        max_passages: 12,
        passage_chars: 800,
      },
    })
    expect(report.synthesis_probe_ok).toBe(true)
    expect(app.answerCalls).toEqual([
      expect.objectContaining({
        query: 'ping',
        model: 'candidate-model',
        base_url: 'http://candidate/v1',
        prompt_version: 'v1',
        max_passages: 1,
        passage_chars: 50,
      }),
    ])
    await close(app.server)
  })

  it('synthesis probe FAILS when the route answers with a fallback (ok:true + debug.fallbackReason)', async () => {
    const app = await startFakeApp(['doc_a', 'doc_twin', 'doc_c'])
    app.answerFallback = 'no_api_key'
    const judge = await startFakeJudge(200)
    const target = gatewayTarget(app.url, fetchJson)
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    let report
    try {
      report = await preflight({
        evalset,
        target,
        judgeCfg: { model: 'm', baseUrl: judge.url },
        passes: 1,
      })
    } finally {
      errSpy.mockRestore()
    }
    expect(report.synthesis_probe_ok).toBe(false)
    expect(report.judge_probe_ok).toBe(false)
    expect(judge.calls).toEqual([])
    await close(app.server)
    await close(judge.server)
  })

  it('prints the retrieval spend of the snippet lookups', async () => {
    const app = await startFakeApp(['doc_a', 'doc_twin', 'doc_c'])
    app.retrievalUsd = 0.02
    const target = gatewayTarget(app.url, fetchJson)
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    let logged = ''
    try {
      await preflight({ evalset, target, passes: 1 })
      logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    } finally {
      logSpy.mockRestore()
    }
    expect(logged).toContain('retrieval spend $0.0200')
    await close(app.server)
  })

  it('lists a missing expected doc and aborts before any synthesis or judge call', async () => {
    const app = await startFakeApp(['doc_a', 'doc_twin']) // doc_c missing
    const judge = await startFakeJudge(200)
    const target = gatewayTarget(app.url, fetchJson)
    const report = await preflight({
      evalset,
      target,
      judgeCfg: { model: 'm', baseUrl: judge.url },
      passes: 2,
    })
    expect(report.corpus_ok).toBe(false)
    expect(report.missing_docs).toEqual(['doc_c'])
    expect(report.synthesis_probe_ok).toBe(false)
    expect(report.judge_probe_ok).toBe(false)
    expect(app.answerCalls).toEqual([])
    expect(judge.calls).toEqual([])
    await close(app.server)
    await close(judge.server)
  })

  it('lists a missing twin (corpus_ok stays true, twins_ok false) and aborts probes', async () => {
    const app = await startFakeApp(['doc_a', 'doc_c']) // doc_twin missing
    const target = gatewayTarget(app.url, fetchJson)
    const report = await preflight({ evalset, target, passes: 1 })
    expect(report.corpus_ok).toBe(true)
    expect(report.twins_ok).toBe(false)
    expect(report.missing_docs).toEqual(['doc_twin'])
    expect(app.answerCalls).toEqual([])
    await close(app.server)
  })

  it('lists a bad snippet with the case id and aborts probes', async () => {
    const app = await startFakeApp(['doc_a', 'doc_twin', 'doc_c'])
    app.chunkTexts = ['Something entirely unrelated to the snippet.']
    const target = gatewayTarget(app.url, fetchJson)
    const report = await preflight({ evalset, target, passes: 1 })
    expect(report.corpus_ok).toBe(true)
    expect(report.snippet_failures).toEqual([
      {
        case_id: 'case1',
        doc_id: 'doc_a',
        reason: expect.stringContaining('not contained'),
      },
    ])
    expect(report.synthesis_probe_ok).toBe(false)
    expect(app.answerCalls).toEqual([])
    await close(app.server)
  })

  it('lists a doc that returns zero chunks as a snippet failure', async () => {
    const app = await startFakeApp(['doc_a', 'doc_twin', 'doc_c'])
    app.chunkTexts = []
    const target = gatewayTarget(app.url, fetchJson)
    const report = await preflight({ evalset, target, passes: 1 })
    expect(report.snippet_failures).toEqual([
      {
        case_id: 'case1',
        doc_id: 'doc_a',
        reason: expect.stringContaining('no chunks'),
      },
    ])
    await close(app.server)
  })

  it('aborts the judge probe when the synthesis probe fails (ok:false 400)', async () => {
    const app = await startFakeApp(['doc_a', 'doc_twin', 'doc_c'])
    app.answerStatus = 400
    const judge = await startFakeJudge(200)
    const target = gatewayTarget(app.url, fetchJson)
    const report = await preflight({
      evalset,
      target,
      judgeCfg: { model: 'm', baseUrl: judge.url },
      passes: 1,
    })
    expect(report.synthesis_probe_ok).toBe(false)
    expect(report.judge_probe_ok).toBe(false)
    expect(judge.calls).toEqual([])
    await close(app.server)
    await close(judge.server)
  })

  it('reports a 401 judge probe as an auth failure', async () => {
    const app = await startFakeApp(['doc_a', 'doc_twin', 'doc_c'])
    const judge = await startFakeJudge(401)
    const target = gatewayTarget(app.url, fetchJson)
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const report = await preflight({
      evalset,
      target,
      judgeCfg: { model: 'm', baseUrl: judge.url, apiKey: 'bad' },
      passes: 1,
    })
    expect(report.synthesis_probe_ok).toBe(true)
    expect(report.judge_probe_ok).toBe(false)
    const errMessages = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(errMessages).toContain('401')
    errSpy.mockRestore()
    logSpy.mockRestore()
    await close(app.server)
    await close(judge.server)
  })

  it('honors only: counts and estimate cover just the selected case; no judgeCfg means judge estimate 0', async () => {
    const app = await startFakeApp(['doc_a', 'doc_twin', 'doc_c'])
    const target = gatewayTarget(app.url, fetchJson)
    const report = await preflight({
      evalset,
      target,
      passes: 2,
      only: ['case1'],
    })
    expect(report.approved).toBe(1)
    expect(report.draft).toBe(0)
    expect(report.rejected).toBe(0)
    expect(report.estimated_calls).toEqual({
      retrieval: 2,
      synthesis: 2,
      judge: 0,
    })
    // No judging in this run — vacuously ok.
    expect(report.judge_probe_ok).toBe(true)
    await close(app.server)
  })

  it('existence gate: a variant-wording snippet the question misses passes as existence-true and is recorded as a rank gap', async () => {
    const app = await startFakeApp(['doc_a', 'doc_twin', 'doc_c'])
    // Exactly 48 code points by construction — the existence lookup's query
    // is this prefix of the (longer) snippet (ruling 6: first 48 code
    // points of the trimmed text_snippet, never the case question).
    const ZH_QUERY =
      '其次，为评估需求侧政策对新能源重卡推广的作用，本文构建了两类政策情景（见表ES-1）：第一类为现'
    const ZH_SNIPPET = ZH_QUERY + '有政策情景，涵盖以旧换新补贴。'
    // The zh source repeats the passage with variant wording (2026-09-08
    // trucks case): the executive-summary chunk contains the snippet; the
    // body chunk a question-based lookup surfaces does not.
    const ES_TEXT = ZH_SNIPPET + '第二类为强化政策情景。'
    const BODY_TEXT =
      '其次，为评估需求侧政策对新能源重卡市场渗透率的作用，本文构建了两类政策情景：第一类为现有政策情景。'
    app.onRetrieval = (b) =>
      b.query === 'What is the projected market penetration rate?'
        ? [BODY_TEXT]
        : [ES_TEXT]
    const zhEvalset: Evalset = {
      ...evalset,
      test_cases: [
        {
          ...evalset.test_cases[0],
          retrieval_ground_truth: {
            expected_external_ids: ['doc_a'],
            expected_passages: [
              {
                doc_id: 'doc_a',
                chunk_id: 'doc_a_chunk_14',
                page: 7,
                text_snippet: ZH_SNIPPET,
              },
            ],
          },
        },
        evalset.test_cases[1],
      ],
    }
    const target = gatewayTarget(app.url, fetchJson)
    const report = await preflight({ evalset: zhEvalset, target, passes: 1 })
    // Existence is proven by the snippet-derived lookup → no failure.
    expect(report.snippet_failures).toEqual([])
    // The question-based lookup missed it → recorded as a rank gap.
    expect(report.rank_gaps).toEqual([
      { case_id: 'case1', doc_id: 'doc_a', snippet_index: 0 },
    ])
    // A rank gap never aborts: the probes ran.
    expect(report.synthesis_probe_ok).toBe(true)
    expect(app.answerCalls).toHaveLength(1)
    // The two lookups, in order: the case question first, then the
    // snippet-derived existence query — identical doc-scoped wide-pool knobs.
    expect(app.retrievalCalls).toEqual([
      {
        query: 'What is the projected market penetration rate?',
        mode: 'answer',
        cite_doc_ids: ['doc_a'],
        rerank: false,
        vector_top_k: 300,
        bm25_top_k: 300,
        fusion_top_k: 300,
        max_results: 300,
      },
      {
        query: ZH_QUERY,
        mode: 'answer',
        cite_doc_ids: ['doc_a'],
        rerank: false,
        vector_top_k: 300,
        bm25_top_k: 300,
        fusion_top_k: 300,
        max_results: 300,
      },
    ])
    await close(app.server)
  })

  it('genuine absence: question and existence lookups both miss → snippet failure, probes skipped', async () => {
    const app = await startFakeApp(['doc_a', 'doc_twin', 'doc_c'])
    app.onRetrieval = () => ['Something entirely unrelated to any snippet.']
    const target = gatewayTarget(app.url, fetchJson)
    const report = await preflight({ evalset, target, passes: 1 })
    expect(report.snippet_failures).toEqual([
      {
        case_id: 'case1',
        doc_id: 'doc_a',
        reason: expect.stringContaining('not contained'),
      },
    ])
    expect(report.rank_gaps).toEqual([])
    expect(report.synthesis_probe_ok).toBe(false)
    expect(app.answerCalls).toEqual([])
    // Both lookups ran: the question first, then the existence query —
    // case1's snippet is under 48 code points, so the derived query is the
    // whole trimmed snippet.
    expect(app.retrievalCalls).toHaveLength(2)
    expect(app.retrievalCalls[1].query).toBe(
      'market penetration rate reaches forty percent',
    )
    await close(app.server)
  })

  it('no-selection mode adds one cite retrieval per case to the estimate; fixture-set does not', async () => {
    const app = await startFakeApp(['doc_a', 'doc_twin', 'doc_c'])
    const target = gatewayTarget(app.url, fetchJson)
    const noSel = await preflight({
      evalset,
      target,
      passes: 2,
      selectionMode: 'no-selection',
    })
    // 2 cases × 2 passes + 2 cite queries (one per case, once per run).
    expect(noSel.estimated_calls.retrieval).toBe(6)
    const fixtureSet = await preflight({
      evalset,
      target,
      passes: 2,
      selectionMode: 'fixture-set',
    })
    expect(fixtureSet.estimated_calls.retrieval).toBe(4)
    await close(app.server)
  })
})
