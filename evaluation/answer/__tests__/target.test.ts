/** @jest-environment node */
import * as http from 'http'
import { fetchJson } from '../http'
import { directTarget, gatewayTarget } from '../target'
import { close, listen, readJsonBody, respondJson } from '../test-server'

describe('gatewayTarget', () => {
  it('retrieve maps the /api/llamaindex answer-mode shape (run-evalset field map)', async () => {
    let body: any
    const server = http.createServer((req, res) => {
      expect(req.method).toBe('POST')
      expect(req.url).toBe('/api/llamaindex')
      readJsonBody(req, (b) => {
        body = b
        respondJson(res, 200, {
          ok: true,
          docs: [
            {
              doc_id: 'doc_a',
              score: 0.9,
              kps: [{ snippet: 'chunk one text' }],
              meta: { raw: { chunk_id: 'doc_a_chunk_1' } },
            },
            {
              doc_id: 'doc_b',
              score: 0.5,
              kps: [{ snippet: 'chunk two text' }],
              meta: { raw: {} },
            },
          ],
          likely_off_topic: true,
          debug: { total_ms: 123 },
          usage: { total_usd: 0.02 },
        })
      })
    })
    const base = await listen(server)
    const target = gatewayTarget(base, fetchJson)
    const out = await target.retrieve('what about trucks?', {
      cite_doc_ids: ['doc_a'],
    })
    expect(body).toEqual({
      query: 'what about trucks?',
      mode: 'answer',
      cite_doc_ids: ['doc_a'],
    })
    // An absent meta.raw.chunk_id stays null (kps[].passage_id is NOT a
    // substitute — it falls back to the doc id).
    expect(out.chunks).toEqual([
      {
        rank: 1,
        doc_id: 'doc_a',
        chunk_id: 'doc_a_chunk_1',
        text: 'chunk one text',
        score: 0.9,
      },
      {
        rank: 2,
        doc_id: 'doc_b',
        chunk_id: null,
        text: 'chunk two text',
        score: 0.5,
      },
    ])
    expect(out.likely_off_topic).toBe(true)
    expect(out.service_ms).toBe(123)
    expect(out.cost_usd).toBe(0.02)
    // The gateway's response docs pass through VERBATIM — capture hands them
    // to /api/answer unchanged.
    expect(out.docs).toEqual([
      {
        doc_id: 'doc_a',
        score: 0.9,
        kps: [{ snippet: 'chunk one text' }],
        meta: { raw: { chunk_id: 'doc_a_chunk_1' } },
      },
      {
        doc_id: 'doc_b',
        score: 0.5,
        kps: [{ snippet: 'chunk two text' }],
        meta: { raw: {} },
      },
    ])
    await close(server)
  })

  it('retrieve throws on a gateway error response', async () => {
    const server = http.createServer((_req, res) => {
      respondJson(res, 400, {
        ok: false,
        error: 'Unknown request field(s): nope',
      })
    })
    const base = await listen(server)
    const target = gatewayTarget(base, fetchJson)
    await expect(target.retrieve('q', { nope: 1 })).rejects.toThrow('400')
    await close(server)
  })

  it('answer maps the /api/answer synthesis contract', async () => {
    let body: any
    const server = http.createServer((req, res) => {
      expect(req.url).toBe('/api/answer')
      readJsonBody(req, (b) => {
        body = b
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
              page: 3,
              text: 'passage text',
            },
          ],
          debug: { knobs: { model: 'gpt-5.4' }, invalid_cites: 0 },
        })
      })
    })
    const base = await listen(server)
    const target = gatewayTarget(base, fetchJson)
    const out = await target.answer('q', [{ doc_id: 'doc_a' }], {
      max_passages: 2,
    })
    expect(body).toEqual({
      query: 'q',
      docs: [{ doc_id: 'doc_a' }],
      max_passages: 2,
    })
    expect(out.ok).toBe(true)
    expect(out.status).toBe(200)
    expect(out.synthesis).toEqual({
      sentences: ['s one', 's two'],
      cites: [[1], [2]],
      source_relevance: [{ doc_id: 'doc_a', tier: 'strong' }],
    })
    expect(out.passages_sent).toEqual([
      {
        id: 1,
        doc_id: 'doc_a',
        chunk_id: 'doc_a_chunk_1',
        page: 3,
        text: 'passage text',
      },
    ])
    expect(out.debug.knobs).toEqual({ model: 'gpt-5.4' })
    await close(server)
  })

  it('answer defaults cites to empty arrays on a fallback response with no cites', async () => {
    const server = http.createServer((_req, res) => {
      respondJson(res, 200, {
        ok: true,
        synthesis: { sentences: ['fallback sentence'] },
        passages_sent: [],
        debug: { fallbackReason: 'no_api_key' },
      })
    })
    const base = await listen(server)
    const target = gatewayTarget(base, fetchJson)
    const out = await target.answer('q', [], {})
    expect(out.ok).toBe(true)
    expect(out.synthesis?.sentences).toEqual(['fallback sentence'])
    expect(out.synthesis?.cites).toEqual([[]])
    expect(out.debug.fallbackReason).toBe('no_api_key')
    await close(server)
  })

  it('answer returns an ok:false outcome for a 400 (bad base_url)', async () => {
    const server = http.createServer((_req, res) => {
      respondJson(res, 400, {
        ok: false,
        error: 'Unsupported provider base_url: https://bad.example/v1',
      })
    })
    const base = await listen(server)
    const target = gatewayTarget(base, fetchJson)
    const out = await target.answer('q', [], {
      base_url: 'https://bad.example/v1',
    })
    expect(out.ok).toBe(false)
    expect(out.status).toBe(400)
    expect(out.error).toContain('base_url')
    expect(out.passages_sent).toEqual([])
    await close(server)
  })

  it('health returns the hybrid_service block', async () => {
    const server = http.createServer((req, res) => {
      expect(req.method).toBe('GET')
      expect(req.url).toBe('/api/llamaindex')
      respondJson(res, 200, {
        ok: true,
        service: 'LlamaIndex API Gateway (Hybrid)',
        hybrid_service: { status: 'healthy', retrieval_backend: 'postgres' },
      })
    })
    const base = await listen(server)
    const target = gatewayTarget(base, fetchJson)
    expect(await target.health()).toEqual({
      status: 'healthy',
      retrieval_backend: 'postgres',
    })
    await close(server)
  })

  it('health returns null when the gateway reports failure', async () => {
    const server = http.createServer((_req, res) => {
      respondJson(res, 503, { ok: false, error: 'Hybrid service unavailable' })
    })
    const base = await listen(server)
    const target = gatewayTarget(base, fetchJson)
    expect(await target.health()).toBeNull()
    await close(server)
  })

  it('catalogIds parses items[].meta.file_path basenames minus .pdf', async () => {
    const server = http.createServer((req, res) => {
      expect(req.url).toBe('/api/catalog')
      respondJson(res, 200, {
        ok: true,
        count: 2,
        items: [
          {
            file_id: 'x',
            file_name: 'x',
            external_file_id: 'x',
            meta: { file_path: '/corpus/doc_a.pdf' },
          },
          {
            file_id: 'y',
            file_name: 'y',
            external_file_id: 'y',
            meta: { file_path: 'doc_b.pdf' },
          },
          { file_id: 'z', file_name: 'z', external_file_id: 'z', meta: {} },
        ],
      })
    })
    const base = await listen(server)
    const target = gatewayTarget(base, fetchJson)
    expect(await target.catalogIds()).toEqual(new Set(['doc_a', 'doc_b']))
    await close(server)
  })
})

describe('directTarget', () => {
  it('routes retrieval to searchUrl /query and app calls to answerUrl', async () => {
    const searchHits: string[] = []
    const appHits: string[] = []
    const searchServer = http.createServer((req, res) => {
      searchHits.push(req.url ?? '')
      if (req.method === 'POST' && req.url === '/query') {
        readJsonBody(req, (b) => {
          expect(b.query).toBe('q')
          expect(b.mode).toBe('answer')
          // Mirrors the gateway's ANSWER_PRESET exactly (minus the fields
          // the preflight overrides) — see the preset assertion below.
          expect(b).toMatchObject({
            similarity_threshold: 0,
            include_metadata: true,
            rerank: true,
            max_results: 15,
            vector_top_k: 150,
            bm25_top_k: 150,
            rerank_top_n: 20,
            fusion_top_k: 100,
            dense_weight: 0.65,
            sparse_weight: 0.35,
          })
          respondJson(res, 200, {
            docs: [
              {
                doc_id: 'doc_a',
                title: 'A',
                content: 'chunk text one',
                score: 0.7,
                metadata: {},
                page: 2,
                chunk_id: 'doc_a_chunk_2',
              },
              {
                doc_id: 'doc_b',
                title: 'B',
                content: 'chunk text two',
                score: 0.4,
                metadata: {},
                page: null,
                chunk_id: null,
              },
            ],
            total_results: 2,
            query: 'q',
            mode: 'answer',
            debug: { total_ms: 55 },
            usage: { total_usd: 0.01 },
            likely_off_topic: false,
          })
        })
      } else if (req.method === 'GET' && req.url === '/health') {
        respondJson(res, 200, {
          status: 'healthy',
          retrieval_backend: 'postgres',
          keyword_backend: 'sparse',
        })
      } else {
        respondJson(res, 404, { ok: false })
      }
    })
    const appServer = http.createServer((req, res) => {
      appHits.push(req.url ?? '')
      if (req.url === '/api/catalog') {
        respondJson(res, 200, {
          ok: true,
          count: 1,
          items: [{ meta: { file_path: 'doc_c.pdf' } }],
        })
      } else if (req.url === '/api/answer') {
        readJsonBody(req, (b) => {
          expect(b).toEqual({ query: 'q', docs: [{ doc_id: 'doc_a' }] })
          respondJson(res, 200, {
            ok: true,
            synthesis: { sentences: ['s'], cites: [[]] },
            passages_sent: [],
            debug: {},
          })
        })
      } else {
        respondJson(res, 404, { ok: false })
      }
    })
    const searchUrl = await listen(searchServer)
    const answerUrl = await listen(appServer)
    const target = directTarget(searchUrl, answerUrl, fetchJson)

    const out = await target.retrieve('q', {})
    expect(out.chunks).toEqual([
      {
        rank: 1,
        doc_id: 'doc_a',
        chunk_id: 'doc_a_chunk_2',
        text: 'chunk text one',
        score: 0.7,
      },
      {
        rank: 2,
        doc_id: 'doc_b',
        chunk_id: null,
        text: 'chunk text two',
        score: 0.4,
      },
    ])
    expect(out.service_ms).toBe(55)
    expect(out.cost_usd).toBe(0.01)
    expect(out.likely_off_topic).toBe(false)
    // Direct mode maps DocumentResults onto the gateway doc shape so
    // /api/answer consumes the same passages the gateway would send.
    expect(out.docs).toEqual([
      {
        doc_id: 'doc_a',
        title: 'A',
        score: 0.7,
        kps: [
          {
            snippet: 'chunk text one',
            passage_id: 'doc_a_chunk_2',
            page: 2,
          },
        ],
      },
      {
        doc_id: 'doc_b',
        title: 'B',
        score: 0.4,
        kps: [
          {
            snippet: 'chunk text two',
            passage_id: 'doc_b',
            page: 1,
          },
        ],
      },
    ])

    const ans = await target.answer('q', [{ doc_id: 'doc_a' }], {})
    expect(ans.ok).toBe(true)
    expect(ans.synthesis?.sentences).toEqual(['s'])

    expect(await target.health()).toEqual({
      status: 'healthy',
      retrieval_backend: 'postgres',
      keyword_backend: 'sparse',
    })
    expect(await target.catalogIds()).toEqual(new Set(['doc_c']))

    expect(searchHits).toEqual(['/query', '/health'])
    expect(appHits).toEqual(['/api/answer', '/api/catalog'])
    await close(searchServer)
    await close(appServer)
  })

  it('retrieve lets knobs override the mirrored preset (max_results for preflight)', async () => {
    let body: any
    const server = http.createServer((req, res) => {
      readJsonBody(req, (b) => {
        body = b
        respondJson(res, 200, {
          docs: [],
          total_results: 0,
          query: 'q',
          mode: 'answer',
          debug: {},
          usage: null,
        })
      })
    })
    const searchUrl = await listen(server)
    const target = directTarget(searchUrl, searchUrl, fetchJson)
    const out = await target.retrieve('q', {
      cite_doc_ids: ['doc_a'],
      max_results: 150,
    })
    expect(body.max_results).toBe(150)
    expect(body.cite_doc_ids).toEqual(['doc_a'])
    expect(out.chunks).toEqual([])
    await close(server)
  })
})
