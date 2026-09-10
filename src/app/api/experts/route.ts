// src/app/api/experts/route.ts
// Experts mode orchestration (spec §3, §5.1). Sequential upstream calls so the
// second hits the query-embedding LRU cache; one works query; pure rank().
import { NextRequest, NextResponse } from 'next/server'
import { CITE_PRESET } from '@/config/retrieval'
import { initializeDatabase } from '@/db/data-source'
import { loadSearchableWorks } from '@/db/queries/expertsEvidence'
import { isTopicDegraded, TOPIC_NO_MATCH } from '@/lib/experts/degraded'
import {
  buildWorkIndex,
  computeDf,
  rank,
  specificity,
  DEFAULT_TOP_N,
  MAX_TOP_N,
} from '@/lib/experts/rank'
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
  excludedTopics: string[],
): MatchedTag[] {
  const excluded = new Set(excludedTopics)
  const N = works.length
  // Translation rows resolve to their original work (spec §2) — rank()'s own
  // index, not a second copy of the rule.
  const byId = buildWorkIndex(works)
  // rank()'s own df, not a second definition of it — the fallback's df is the
  // number the response reports, so the two must never disagree.
  const df = computeDf(works)
  const retrievedWorks = new Set<WorkRow>()
  for (const r of retrieved) {
    const w = byId.get(r.docId)
    if (w) retrievedWorks.add(w)
  }
  const count = new Map<string, number>()
  // Spec §5.1: excluded topics leave the topic space — skipped here so they
  // never become fallback candidates (and the top-10 is over non-excluded
  // topics only).
  for (const w of retrievedWorks)
    for (const t of new Set(w.topics)) {
      if (excluded.has(t)) continue
      count.set(t, (count.get(t) ?? 0) + 1)
    }
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
      // No dense_weight/sparse_weight, matching the cite branch of
      // /api/llamaindex. CITE_PRESET.alpha (0.5) happens to equal the search
      // service's QueryRequest default, so the lanes are weighted identically
      // today — but that equality is a coincidence, not a contract. Retune
      // CITE_PRESET.alpha and cite mode moves while experts evidence silently
      // does not. Send it explicitly the moment the two diverge.
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
    // Spec §9: an empty tags-derived topic list plus retrieved docs means the
    // graph would have no topic nodes at all — substitute the retrieved works'
    // own accepted tags. The trigger is the EMPTY LIST, not the `degraded`
    // array: /tags/nearby can answer 200 with an empty topic facet it did not
    // name in `degraded` (older or partial deployments), and the page would
    // then render zero chips, an edgeless graph, no peers, and a ranking that
    // silently lost S(p) — with nothing in `degraded` to explain it. This
    // fills understanding.matched_topics (chips, graph, peers) but MUST NOT
    // enter rank()'s scoring — rank() already ran with the (empty)
    // tags-derived list.
    // I-5: never in topic_only mode. There, `score = S/maxS` and rank() has
    // already run with an empty topic list, so every score is 0 and `people` is
    // empty — filling the chips would show ten topics above "No one in the
    // corpus has published near this." Spec §4.4 reserves the nothing-state for
    // D empty AND T_topic empty; substituting chips that fed no ranking is
    // exactly the dishonesty this fallback exists to avoid.
    if (
      topics.length === 0 &&
      retrieved.length > 0 &&
      result.mode === 'evidence'
    ) {
      const fb = fallbackTopics(retrieved, works, excludedTopics)
      result.matchedTopics = fb
      const fbLabels = new Set(fb.map((t) => t.label))
      for (const p of result.people)
        for (const t of p.topics) if (fbLabels.has(t.label)) t.matched = true
      // I-1: the substitution must always be visible, but WHY it happened is
      // two different facts and the page words them differently. The service
      // deliberately does not call "covered facet, nothing above the cosine
      // floor" a degradation, so neither do we — that is TOPIC_NO_MATCH.
      if (!isTopicDegraded(degraded)) degraded.push(TOPIC_NO_MATCH)
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
      total_works: works.length,
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
