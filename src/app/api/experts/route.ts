// src/app/api/experts/route.ts
// Experts mode orchestration (spec §3, §5.1). Sequential upstream calls so the
// second hits the query-embedding LRU cache; one works query; pure rank().
import { NextRequest, NextResponse } from 'next/server'
import { CITE_PRESET } from '@/config/retrieval'
import { initializeDatabase } from '@/db/data-source'
import { loadSearchableWorks } from '@/db/queries/expertsEvidence'
import { rank, DEFAULT_TOP_N, MAX_TOP_N } from '@/lib/experts/rank'
import type { ExpertsResponse, RetrievedDoc, Tier } from '@/lib/experts/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SEARCH_SERVICE_URL =
  process.env.SEARCH_SERVICE_URL || 'http://localhost:8000'
// Evidence coverage: the UI's CITE_PRESET.maxResults (25) is a list-length
// cap, not a relevance one; the experts evidence term needs every work that
// cleared the logit floor. The reranker window (rerank_candidates=100, 2 per
// doc) is the real ceiling — see spec §3.
const EVIDENCE_MAX_RESULTS = 200
const TOPIC_TOP_K = 10
const GEO_TOP_K = 3
const TIERS: Tier[] = ['strong', 'partial', 'weak']

interface QueryDoc {
  doc_id: string
  metadata?: { doc_id?: string; relevance_tier?: string }
}
interface QueryReply {
  docs: QueryDoc[]
  usage?: Record<string, unknown> | null
  query_understanding?: {
    suggestions?: { type: string; text: string }[]
  } | null
  likely_off_topic?: boolean
}
interface TagsReply {
  facets: Record<string, [string, number][]>
  degraded: string[]
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SEARCH_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return (await res.json()) as T
}

export async function POST(req: NextRequest) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid JSON body' },
      { status: 400 },
    )
  }
  const query = typeof body?.query === 'string' ? body.query.trim() : ''
  if (!query)
    return NextResponse.json(
      { ok: false, error: 'query is required' },
      { status: 400 },
    )
  if (
    body.top_n !== undefined &&
    !(
      Number.isInteger(body.top_n) &&
      body.top_n >= 1 &&
      body.top_n <= MAX_TOP_N
    )
  ) {
    return NextResponse.json(
      { ok: false, error: `top_n must be an integer 1..${MAX_TOP_N}` },
      { status: 400 },
    )
  }
  if (
    body.excluded_topics !== undefined &&
    !(
      Array.isArray(body.excluded_topics) &&
      body.excluded_topics.every((t: unknown) => typeof t === 'string')
    )
  ) {
    return NextResponse.json(
      { ok: false, error: 'excluded_topics must be a string array' },
      { status: 400 },
    )
  }
  const topN: number = body.top_n ?? DEFAULT_TOP_N
  const excludedTopics: string[] = body.excluded_topics ?? []
  const degraded: string[] = []
  const timing: Record<string, number> = {}

  // 1. Evidence.
  let retrieved: RetrievedDoc[] = []
  let usage: Record<string, unknown> | null = null
  let suggestions: { type: string; text: string }[] = []
  let likelyOffTopic = false
  let t0 = Date.now()
  try {
    const q = await postJson<QueryReply>('/query', {
      query,
      mode: 'cite',
      max_results: EVIDENCE_MAX_RESULTS,
      similarity_threshold: 0,
      include_metadata: true,
      rerank: true,
      vector_top_k: CITE_PRESET.denseTopK,
      bm25_top_k: CITE_PRESET.sparseTopK,
      rerank_top_n: CITE_PRESET.rerankTopN,
      fusion_top_k: CITE_PRESET.fusionTopK,
    })
    retrieved = (q.docs ?? []).flatMap((d, i) => {
      const tier = d.metadata?.relevance_tier as Tier | undefined
      const id = d.metadata?.doc_id ?? d.doc_id
      return tier && TIERS.includes(tier) && id
        ? [{ docId: id, tier, rank: i + 1 }]
        : []
    })
    usage = q.usage ?? null
    suggestions = q.query_understanding?.suggestions ?? []
    likelyOffTopic = q.likely_off_topic ?? false
  } catch (err) {
    console.warn('[experts] /query degraded:', err)
    degraded.push('query')
  }
  timing.query_ms = Date.now() - t0

  // 2. Topic space (after /query so the embedding cache is warm).
  let topics: [string, number][] = []
  let geographies: [string, number][] = []
  t0 = Date.now()
  try {
    const t = await postJson<TagsReply>('/tags/nearby', {
      query,
      facets: ['topic', 'geography'],
      top_k: TOPIC_TOP_K,
    })
    topics = t.facets.topic ?? []
    geographies = (t.facets.geography ?? []).slice(0, GEO_TOP_K)
    for (const f of t.degraded ?? []) degraded.push(`tags_nearby:${f}`)
  } catch (err) {
    console.warn('[experts] /tags/nearby degraded:', err)
    degraded.push('tags_nearby')
  }
  timing.tags_ms = Date.now() - t0

  if (degraded.includes('query') && degraded.includes('tags_nearby')) {
    return NextResponse.json(
      { ok: false, error: 'search service unavailable' },
      { status: 502 },
    )
  }

  // 3. Works + rank.
  try {
    t0 = Date.now()
    await initializeDatabase()
    const works = await loadSearchableWorks()
    timing.db_ms = Date.now() - t0
    t0 = Date.now()
    const result = rank({
      works,
      retrieved,
      matchedTopics: topics.map(([label, cosine]) => ({ label, cosine })),
      excludedTopics,
      likelyOffTopic,
      currentYear: new Date().getFullYear(),
      topN,
    })
    timing.rank_ms = Date.now() - t0
    const geoDf = new Map<string, number>()
    for (const w of works)
      for (const g of new Set(w.geographies))
        geoDf.set(g, (geoDf.get(g) ?? 0) + 1)
    const response: ExpertsResponse = {
      ok: true,
      query,
      mode: result.mode,
      understanding: {
        matched_topics: result.matchedTopics,
        matched_geographies: geographies.map(([label, cosine]) => ({
          label,
          cosine,
          df: geoDf.get(label) ?? 0,
        })),
        likely_off_topic: likelyOffTopic,
        suggestions,
        degraded,
      },
      people: result.people,
      total_people: result.totalPeople,
      docs: result.docs,
      organizations: result.organizations,
      usage,
      timing,
    }
    return NextResponse.json(response)
  } catch (err) {
    console.error('[experts] failed:', err)
    return NextResponse.json(
      { ok: false, error: 'internal error' },
      { status: 500 },
    )
  }
}
