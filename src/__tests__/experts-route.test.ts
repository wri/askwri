/**
 * @jest-environment node
 *
 * Contract tests for POST /api/experts. The search service is a mocked global
 * fetch (two calls: /query then /tags/nearby); the works query is stubbed.
 */
import { NextRequest } from 'next/server'
import type { WorkRow } from '@/lib/experts/types'

const WORKS: WorkRow[] = [
  {
    docId: 'd1',
    translations: [],
    title: 'Bus paper',
    year: 2025,
    type: 'Report',
    office: 'WRI China',
    url: 'https://x/1',
    authorsRaw: ['Xue, Lulu'],
    topics: ['Buses'],
    geographies: ['China'],
  },
  {
    docId: 'd2',
    translations: [],
    title: 'School bus',
    year: 2024,
    type: 'Report',
    office: 'WRI US',
    url: null,
    authorsRaw: ['Lazer, Leah'],
    topics: ['School Buses'],
    geographies: [],
  },
]

jest.mock('@/db/data-source', () => ({
  initializeDatabase: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/db/queries/expertsEvidence', () => ({
  loadSearchableWorks: jest.fn(),
}))

// jest.resetModules() clears the mock registry as well (jest 29), so the
// mocked module the route's dynamic import sees is created fresh per test —
// re-acquire the mock after the reset; a top-level requireMock would go stale.
let loadSearchableWorks: jest.Mock
let fetchMock: jest.SpyInstance
const ENV = { ...process.env }

function queryReply(
  docs: { doc_id: string; tier: string }[],
  extra: Record<string, unknown> = {},
) {
  return {
    docs: docs.map((d, i) => ({
      doc_id: d.doc_id,
      title: d.doc_id,
      content: '',
      score: 1 - i * 0.1,
      metadata: { doc_id: d.doc_id, relevance_tier: d.tier },
    })),
    total_results: docs.length,
    query: 'q',
    mode: 'cite',
    debug: {},
    usage: { total_usd: 0.01 },
    query_understanding: {
      suggestions: [{ type: 'nearby_topic', text: 'Buses' }],
    },
    likely_off_topic: false,
    ...extra,
  }
}
function tagsReply(
  topic: [string, number][],
  geography: [string, number][] = [],
  degraded: string[] = [],
) {
  return { facets: { topic, geography }, model: 'cohere-embed-v4', degraded }
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/experts/route')
  const res = await POST(
    new NextRequest('http://localhost/api/experts', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  )
  return { status: res.status, json: await res.json() }
}

beforeEach(() => {
  jest.resetModules()
  process.env = { ...ENV, SEARCH_SERVICE_URL: 'http://search:8000' }
  ;({ loadSearchableWorks } = jest.requireMock('@/db/queries/expertsEvidence'))
  loadSearchableWorks.mockResolvedValue(WORKS)
  fetchMock = jest.spyOn(global, 'fetch')
})
afterEach(() => fetchMock.mockRestore())

describe('POST /api/experts', () => {
  it('calls /query with max_results 200 then /tags/nearby, and ranks', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(queryReply([{ doc_id: 'd1', tier: 'strong' }])),
      )
      .mockResolvedValueOnce(
        json(
          tagsReply(
            [
              ['Buses', 0.66],
              ['School Buses', 0.5],
            ],
            [['China', 0.4]],
          ),
        ),
      )
    const { status, json: body } = await post({ query: 'electric buses' })
    expect(status).toBe(200)
    const [queryUrl, queryInit] = fetchMock.mock.calls[0]
    expect(queryUrl).toBe('http://search:8000/query')
    const sent = JSON.parse(queryInit.body)
    expect(sent).toMatchObject({
      query: 'electric buses',
      mode: 'cite',
      max_results: 200,
      rerank: true,
      vector_top_k: 500,
      bm25_top_k: 500,
      fusion_top_k: 500,
      rerank_top_n: 500,
    })
    const [tagsUrl, tagsInit] = fetchMock.mock.calls[1]
    expect(tagsUrl).toBe('http://search:8000/tags/nearby')
    expect(JSON.parse(tagsInit.body)).toEqual({
      query: 'electric buses',
      facets: ['topic', 'geography'],
      top_k: 10,
    })
    expect(body.ok).toBe(true)
    expect(body.total_works).toBe(2)
    expect(body.mode).toBe('evidence')
    expect(body.people[0]).toMatchObject({ key: 'xue, lulu', score: 1 })
    expect(body.understanding.matched_topics).toEqual([
      { label: 'Buses', cosine: 0.66, df: 1 },
      { label: 'School Buses', cosine: 0.5, df: 1 },
    ])
    expect(body.understanding.matched_geographies).toEqual([
      { label: 'China', cosine: 0.4, df: 1 },
    ])
    expect(body.understanding.suggestions).toEqual([
      { type: 'nearby_topic', text: 'Buses' },
    ])
    expect(body.usage).toEqual({ total_usd: 0.01 })
    expect(Object.keys(body.timing)).toEqual(
      expect.arrayContaining(['query_ms', 'tags_ms', 'db_ms', 'rank_ms']),
    )
  })

  it('degrades to evidence-only when /tags/nearby fails', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(queryReply([{ doc_id: 'd1', tier: 'strong' }])),
      )
      .mockResolvedValueOnce(json({ error: 'boom' }, 500))
    const { status, json: body } = await post({ query: 'electric buses' })
    expect(status).toBe(200)
    expect(body.understanding.degraded).toEqual(['tags_nearby'])
    // spec §9: graph falls back to topics from the docs' own accepted tags.
    expect(body.understanding.matched_topics).toEqual([
      { label: 'Buses', cosine: 1, df: 1 },
    ])
    expect(body.people[0].key).toBe('xue, lulu')
  })

  it('derives matched_topics from retrieved docs when the topic facet is degraded (spec §9)', async () => {
    // /tags/nearby returns 200 but names the topic facet degraded and empty;
    // /query returns two docs with distinct accepted topics.
    fetchMock
      .mockResolvedValueOnce(
        json(
          queryReply([
            { doc_id: 'd1', tier: 'strong' },
            { doc_id: 'd2', tier: 'strong' },
          ]),
        ),
      )
      .mockResolvedValueOnce(json(tagsReply([], [], ['topic'])))
    const { status, json: body } = await post({ query: 'electric buses' })
    expect(status).toBe(200)
    // degraded still names the topic facet.
    expect(body.understanding.degraded).toEqual(['tags_nearby:topic'])
    // mode stays evidence (retrieved docs exist).
    expect(body.mode).toBe('evidence')
    // matched_topics is doc-derived. Both fixture topics have count 1 and
    // df 1, so both score ln(2/1) and both normalize to strength 1; the tie
    // breaks alphabetically. Asserted exactly — a recomputed-from-the-response
    // check would be vacuous here. Ordering by a genuinely different
    // count × specificity is covered by the next test.
    const mt = body.understanding.matched_topics
    expect(mt).toEqual([
      { label: 'Buses', cosine: 1, df: 1 },
      { label: 'School Buses', cosine: 1, df: 1 },
    ])
    // fallback did not feed the score: top person is a pure-evidence ranking.
    expect(body.people[0].score).toBe(1)
    expect(body.people[0].evidence.docs).toBeGreaterThan(0)
    // people's topics carry matched:true for fallback labels.
    const fbLabels = new Set(mt.map((t: any) => t.label))
    for (const p of body.people)
      for (const t of p.topics)
        if (fbLabels.has(t.label)) expect(t.matched).toBe(true)
  })

  // T1 (spec §9): /tags/nearby answers 200 with an EMPTY topic facet that it
  // did NOT name in `degraded`. The substitution must still happen — otherwise
  // the page renders zero chips, an edgeless graph and no peers with nothing in
  // `understanding.degraded` to explain it — and the response must name the
  // topic facet so the substitution is visible to the page and to the logs.
  it('falls back when the topic facet is empty but NOT marked degraded, and names it', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(
          queryReply([
            { doc_id: 'd1', tier: 'strong' },
            { doc_id: 'd2', tier: 'strong' },
          ]),
        ),
      )
      // 200, empty topic facet, empty degraded array.
      .mockResolvedValueOnce(json(tagsReply([], [['China', 0.4]], [])))
    const { status, json: body } = await post({ query: 'electric buses' })
    expect(status).toBe(200)
    expect(body.understanding.matched_topics.map((t: any) => t.label)).toEqual([
      'Buses',
      'School Buses',
    ])
    // the substitution is now visible in the response.
    // I-1: the service answered correctly and simply found nothing above the
    // cosine floor — it deliberately does not call that degraded, so neither do
    // we. The fallback is still named, under its own token, so the page can
    // word it "nothing cleared the threshold" rather than "lane unavailable".
    expect(body.understanding.degraded).toEqual(['tags_nearby:topic_no_match'])
    // geography, which was NOT empty, is untouched.
    expect(body.understanding.matched_geographies).toEqual([
      { label: 'China', cosine: 0.4, df: 1 },
    ])
  })

  // T4: the fallback's ordering is score = count(t) · ln(N / df(t)), and the
  // strength slot is score / maxScore. This fixture makes the two scores
  // genuinely different AND puts the winner alphabetically LAST, so neither a
  // reversed comparator nor an accidental alphabetical sort can pass.
  //   N = 4 works. df: Zero-Emission Buses 1, Transport 3, Freight 1.
  //   retrieved = {d1, d2} -> count: Zero-Emission Buses 1, Transport 2.
  //   Zero-Emission Buses = 1 · ln(4/1) = 1.3862943611  -> strength 1
  //   Transport           = 2 · ln(4/3) = 0.5753641449  -> strength 0.4150375
  it('orders doc-derived fallback topics by count × specificity', async () => {
    const w = (
      docId: string,
      authorsRaw: string[],
      topics: string[],
    ): WorkRow => ({
      docId,
      translations: [],
      title: docId,
      year: 2025,
      type: 'Report',
      office: 'WRI China',
      url: null,
      authorsRaw,
      topics,
      geographies: [],
    })
    loadSearchableWorks.mockResolvedValue([
      w('d1', ['Xue, Lulu'], ['Zero-Emission Buses', 'Transport']),
      w('d2', ['Xue, Lulu'], ['Transport']),
      w('d3', ['Lazer, Leah'], ['Transport']),
      w('d4', ['Lazer, Leah'], ['Freight']),
    ])
    fetchMock
      .mockResolvedValueOnce(
        json(
          queryReply([
            { doc_id: 'd1', tier: 'strong' },
            { doc_id: 'd2', tier: 'strong' },
          ]),
        ),
      )
      .mockResolvedValueOnce(json(tagsReply([], [], ['topic'])))
    const { status, json: body } = await post({ query: 'electric buses' })
    expect(status).toBe(200)
    const mt = body.understanding.matched_topics
    expect(mt.map((t: any) => t.label)).toEqual([
      'Zero-Emission Buses',
      'Transport',
    ])
    expect(mt[0].df).toBe(1)
    expect(mt[1].df).toBe(3)
    expect(mt[0].cosine).toBeCloseTo(1, 6)
    expect(mt[1].cosine).toBeCloseTo(0.4150375, 6)
    // 'Freight' is on no retrieved work, so it is not a fallback node at all.
    expect(mt.length).toBe(2)
  })

  it('filters excluded_topics out of the doc-derived fallback (spec §5.1)', async () => {
    const degradedTags = () =>
      json(
        queryReply([
          { doc_id: 'd1', tier: 'strong' },
          { doc_id: 'd2', tier: 'strong' },
        ]),
      )
    const labels = (body: any) =>
      body.understanding.matched_topics.map((t: any) => t.label)
    // Control: without exclusions the fallback still includes the label.
    fetchMock
      .mockResolvedValueOnce(degradedTags())
      .mockResolvedValueOnce(json(tagsReply([], [], ['topic'])))
    const control = await post({ query: 'electric buses' })
    expect(control.status).toBe(200)
    expect(labels(control.json)).toContain('Buses')
    // Excluding 'Buses' must remove it from the fallback chips entirely.
    fetchMock
      .mockResolvedValueOnce(degradedTags())
      .mockResolvedValueOnce(json(tagsReply([], [], ['topic'])))
    const excluded = await post({
      query: 'electric buses',
      excluded_topics: ['Buses'],
    })
    expect(excluded.status).toBe(200)
    expect(labels(excluded.json)).not.toContain('Buses')
    expect(labels(excluded.json)).toContain('School Buses')
  })

  it('degrades to topic_only when /query fails', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(json(tagsReply([['School Buses', 0.7]])))
    const { status, json: body } = await post({ query: 'school buses' })
    expect(status).toBe(200)
    expect(body.mode).toBe('topic_only')
    expect(body.understanding.degraded).toEqual(['query'])
    expect(body.people[0].key).toBe('lazer, leah')
  })

  // spec §9 / isTopicDegraded: a geography-only degradation leaves the topic
  // cosines real, so the doc-derived substitution must NOT happen.
  it('does not fall back when only the geography facet is degraded', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(queryReply([{ doc_id: 'd1', tier: 'strong' }])),
      )
      .mockResolvedValueOnce(
        json(tagsReply([['School Buses', 0.5]], [], ['geography'])),
      )
    const { status, json: body } = await post({ query: 'electric buses' })
    expect(status).toBe(200)
    expect(body.understanding.degraded).toEqual(['tags_nearby:geography'])
    // real query->tag cosines, NOT the doc-derived strengths (which would have
    // been [{ label: 'Buses', cosine: 1 }] from the retrieved d1).
    expect(body.understanding.matched_topics).toEqual([
      { label: 'School Buses', cosine: 0.5, df: 1 },
    ])
    expect(body.understanding.matched_geographies).toEqual([])
  })

  // spec §4.4 + §9: /query succeeded but retrieved nothing AND the topic facet
  // is gone. There are no retrieved works to derive topics from, so there is
  // nothing to substitute: mode is topic_only, no people, and the response
  // still carries `degraded` plus the nearby-topic suggestions the page shows
  // in the nothing-at-all state. Asserted as the intended behavior, not an
  // accident of the `retrieved.length > 0` guard.
  it('returns the nothing-at-all state when /query finds no docs and tags are degraded', async () => {
    fetchMock
      .mockResolvedValueOnce(json(queryReply([])))
      .mockResolvedValueOnce(json({ error: 'boom' }, 500))
    const { status, json: body } = await post({ query: 'quantum knitting' })
    expect(status).toBe(200)
    expect(body.mode).toBe('topic_only')
    expect(body.understanding.degraded).toEqual(['tags_nearby'])
    expect(body.understanding.matched_topics).toEqual([])
    expect(body.people).toEqual([])
    expect(body.total_people).toBe(0)
    // the page's only remaining affordance (spec §4.4).
    expect(body.understanding.suggestions).toEqual([
      { type: 'nearby_topic', text: 'Buses' },
    ])
  })

  // spec §4.4: likely_off_topic forces topic_only even with retrieved docs.
  it('threads likely_off_topic through and ranks topic_only', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(
          queryReply([{ doc_id: 'd1', tier: 'strong' }], {
            likely_off_topic: true,
          }),
        ),
      )
      .mockResolvedValueOnce(json(tagsReply([['Buses', 0.66]])))
    const { status, json: body } = await post({ query: 'electric buses' })
    expect(status).toBe(200)
    expect(body.mode).toBe('topic_only')
    expect(body.understanding.likely_off_topic).toBe(true)
    expect(body.understanding.degraded).toEqual([])
    expect(body.people[0].key).toBe('xue, lulu')
    // no retrieval claim survives the topic_only branch.
    expect(body.people[0].evidence.docs).toBe(0)
    expect(body.people[0].evidence.strong).toBe(0)
  })

  // I-5: the doc-derived fallback must not fire in topic_only mode.
  it('does not substitute doc-derived topics in topic_only mode', async () => {
    // likely_off_topic with retrieved docs AND an empty topic facet. rank() has
    // already scored on an empty topic term, so every score is 0 and `people`
    // is empty. Filling the chips anyway would put ten topics above the page's
    // "No one in the corpus has published near this." — spec §4.4 reserves that
    // state for D empty AND T_topic empty, and the chips would have fed nothing.
    fetchMock
      .mockResolvedValueOnce(
        json(
          queryReply([{ doc_id: 'd1', tier: 'strong' }], {
            likely_off_topic: true,
          }),
        ),
      )
      .mockResolvedValueOnce(json(tagsReply([])))
    const { status, json: body } = await post({ query: 'electric buses' })
    expect(status).toBe(200)
    expect(body.mode).toBe('topic_only')
    expect(body.understanding.matched_topics).toEqual([])
    expect(body.understanding.degraded).toEqual([])
    expect(body.people).toEqual([])
  })

  it('returns 502 when both upstreams fail', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
    const { status, json: body } = await post({ query: 'anything' })
    expect(status).toBe(502)
    expect(body.ok).toBe(false)
  })

  it('rejects a malformed JSON body with 400', async () => {
    const { POST } = await import('@/app/api/experts/route')
    const res = await POST(
      new NextRequest('http://localhost/api/experts', {
        method: 'POST',
        body: '{"query": "electric buses"',
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'invalid JSON body' })
    // it never reached the search service.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('validates the body', async () => {
    expect((await post({ query: '   ' })).status).toBe(400)
    expect((await post({ query: 'x', excluded_topics: 'Buses' })).status).toBe(
      400,
    )
    expect(
      (await post({ query: 'x', excluded_topics: ['ok', 7] })).status,
    ).toBe(400)
  })

  // spec §5.1: top_n is an integer 1..50. Type, both bounds, and non-integer.
  it.each([
    ['a string', 'lots'],
    ['zero', 0],
    ['above the max', 51],
    ['a non-integer', 2.5],
  ])('rejects top_n %s', async (_label, top_n) => {
    const { status, json: body } = await post({ query: 'x', top_n })
    expect(status).toBe(400)
    expect(body).toEqual({
      ok: false,
      error: 'top_n must be an integer 1..50',
    })
  })

  it('accepts top_n at both ends of the allowed range', async () => {
    for (const top_n of [1, 50]) {
      fetchMock
        .mockResolvedValueOnce(
          json(queryReply([{ doc_id: 'd1', tier: 'strong' }])),
        )
        .mockResolvedValueOnce(json(tagsReply([['Buses', 0.66]])))
      expect((await post({ query: 'x', top_n })).status).toBe(200)
    }
  })

  it('threads excluded_topics into the ranking', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(queryReply([{ doc_id: 'd1', tier: 'strong' }])),
      )
      .mockResolvedValueOnce(
        json(
          tagsReply([
            ['Buses', 0.66],
            ['School Buses', 0.5],
          ]),
        ),
      )
    const { json: body } = await post({
      query: 'buses',
      excluded_topics: ['Buses'],
    })
    expect(body.understanding.matched_topics.map((t: any) => t.label)).toEqual([
      'School Buses',
    ])
  })

  it('returns 500 when the works query fails', async () => {
    loadSearchableWorks.mockRejectedValueOnce(new Error('db down'))
    fetchMock
      .mockResolvedValueOnce(json(queryReply([])))
      .mockResolvedValueOnce(json(tagsReply([])))
    expect((await post({ query: 'x' })).status).toBe(500)
  })
})
