// src/app/api/experts/route.ts
// Experts mode orchestration (spec §3, §5.1). Sequential upstream calls so the
// second hits the query-embedding LRU cache; one works query; pure rank().
import { NextRequest, NextResponse } from 'next/server'
import { CITE_PRESET } from '@/config/retrieval'
import { initializeDatabase } from '@/db/data-source'
import { loadSearchableWorks } from '@/db/queries/expertsEvidence'
import { rank, specificity, DEFAULT_TOP_N, MAX_TOP_N } from '@/lib/experts/rank'
import type {
  ExpertsResponse,
  MatchedTag,
  RetrievedDoc,
  Tier,
  WorkRow,
} from '@/lib/experts/types'

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

// Spec §9 graph fallback: when /tags/nearby's topic facet is degraded, derive
// the topic nodes from the retrieved works' own accepted tags. score(t) =
// count(t) · specificity(df(t), N); the cosine slot carries score/maxScore, a
// 0..1 display strength — NOT a true cosine. Top 10 by score. Pure; never
// enters rank() (scoring stays evidence-only on degradation).
function fallbackTopics(
  retrieved: RetrievedDoc[],
  works: WorkRow[],
): MatchedTag[] {
  const N = works.length
  const byId = new Map<string, WorkRow>()
  for (const w of works) {
    byId.set(w.docId, w)
    for (const tr of w.translations) byId.set(tr, w)
  }
  const df = new Map<string, number>()
  for (const w of works)
    for (const t of new Set(w.topics)) df.set(t, (df.get(t) ?? 0) + 1)
  const retrievedWorks = new Set<WorkRow>()
  for (const r of retrieved) {
    const w = byId.get(r.docId)
    if (w) retrievedWorks.add(w)
  }
  const count = new Map<string, number>()
  for (const w of retrievedWorks)
    for (const t of new Set(w.topics)) count.set(t, (count.get(t) ?? 0) + 1)
  const scored = [...count.entries()].map(([label, c]) => ({
    label,
    score: c * specificity(df.get(label) ?? 1, N),
  }))
  scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
  const top = scored.slice(0, TOPIC_TOP_K)
  const maxScore = top[0]?.score ?? 0
  return top.map(({ label, score }) => ({
    label,
    // display strength, not a true cosine
    cosine: maxScore > 0 ? score / maxScore : 0,
    df: df.get(label) ?? 0,
  }))
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
    // Spec §9: when the topic facet is degraded, the tags-derived topic list
    // is empty, and /query produced retrieved docs, populate the graph's
    // topic nodes from the retrieved works' own accepted tags. This fills
    // understanding.matched_topics (chips, graph, peers) but MUST NOT enter
    // rank()'s scoring — rank() already ran with the (empty) tags-derived list.
    const topicDegraded =
      degraded.includes('tags_nearby') || degraded.includes('tags_nearby:topic')
    if (topicDegraded && topics.length === 0 && retrieved.length > 0) {
      const fb = fallbackTopics(retrieved, works)
      result.matchedTopics = fb
      const fbLabels = new Set(fb.map((t) => t.label))
      for (const p of result.people)
        for (const t of p.topics) if (fbLabels.has(t.label)) t.matched = true
    }
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
