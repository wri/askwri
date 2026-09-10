// src/lib/experts/rank.ts
// Experts-mode ranking (spec §4). Pure: no I/O, no Date.now().
//
// PROTOTYPE DEFAULTS. Every constant below is a starting point, not a tuned
// value; no labeled query set exists yet (evaluation/experts/). Changing one
// re-orders every result list with no instrument to say whether that was an
// improvement — record a before/after on the labeled set when one exists.
import { buildAuthorIndex, resolveAuthor } from './authorKey'
import type {
  AuthorRef,
  DocResult,
  MatchedTag,
  PersonResult,
  RankResult,
  RetrievedDoc,
  Tier,
  WorkRow,
} from './types'

export const TIER_W: Record<Tier, number> = {
  strong: 1,
  partial: 0.5,
  weak: 0.15,
}
export const POS_DECAY = 0.3 // pos_w = 1 / (1 + POS_DECAY * index)
export const EVIDENCE_WEIGHT = 0.7
export const TOPIC_WEIGHT = 0.3
export const MAX_CANDIDATES = 300
export const DEFAULT_TOP_N = 20
export const MAX_TOP_N = 50

export interface RankOptions {
  works: WorkRow[]
  retrieved: RetrievedDoc[]
  matchedTopics: { label: string; cosine: number }[]
  excludedTopics?: string[]
  likelyOffTopic?: boolean
  currentYear: number
  topN?: number
}

export function specificity(df: number, n: number): number {
  return Math.log(Math.max(n, 1) / Math.max(df, 1))
}

/** docId -> work, including every confirmed translation id pointing at its
 *  original (spec §4.1). Exported because /api/experts needs the identical
 *  resolution for the §9 doc-derived fallback; two copies drifted apart once. */
export function buildWorkIndex(works: WorkRow[]): Map<string, WorkRow> {
  const byId = new Map<string, WorkRow>()
  for (const w of works) {
    byId.set(w.docId, w)
    for (const tr of w.translations) byId.set(tr, w)
  }
  return byId
}

export function computeDf(works: WorkRow[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const w of works)
    for (const t of new Set(w.topics)) df.set(t, (df.get(t) ?? 0) + 1)
  return df
}

function recencyWeight(year: number | null, currentYear: number): number {
  if (year == null) return 0.7
  if (year >= currentYear - 3) return 1
  if (year >= currentYear - 7) return 0.85
  return 0.7
}

interface PersonAcc {
  ref: AuthorRef
  evidence: number
  topic: number
  docIds: Set<string> // retrieved works, then back-filled with topic works
  retrievedDocs: number // works actually retrieved — what `evidence.docs` reports
  tiers: Record<Tier, number>
  offices: Record<string, number>
  years: number[]
  topicCounts: Map<string, number> // over ALL the person's works
  corpusDocs: number
}

export function rank(
  opts: RankOptions,
): RankResult & { matchedTopics: MatchedTag[] } {
  const { works, currentYear } = opts
  const topN = Math.min(Math.max(opts.topN ?? DEFAULT_TOP_N, 1), MAX_TOP_N)
  const excluded = new Set(opts.excludedTopics ?? [])
  const N = works.length
  const df = computeDf(works)
  const matched: MatchedTag[] = opts.matchedTopics
    .filter((t) => !excluded.has(t.label))
    .map((t) => ({
      label: t.label,
      cosine: t.cosine,
      df: df.get(t.label) ?? 0,
    }))
  const matchedLabels = new Set(matched.map((t) => t.label))

  const byId = buildWorkIndex(works)

  // Author resolution over the whole corpus (sibling lookup needs every form).
  const index = buildAuthorIndex(works.flatMap((w) => w.authorsRaw))
  // Dedupe by RESOLVED key, not by raw string: a work's authorsRaw is the
  // union of its rows' authors (spec §4.1), and a translation row can store
  // `Lulu Xue` where the original stores `Xue, Lulu`. Both survive the
  // exact-string dedupe in expertsEvidence and resolve to one person here, so
  // without this every per-work count would fire twice and the phantom entry
  // would shift the position index of every co-author after it. The key is
  // only known after resolveAuthor (which needs the corpus-wide sibling
  // index), which is why this cannot be done in SQL. First occurrence wins:
  // the order is the author position that pos_w reads.
  const authorsOf = new Map<string, AuthorRef[]>()
  for (const w of works) {
    const seen = new Set<string>()
    const refs: AuthorRef[] = []
    for (const raw of w.authorsRaw) {
      const a = resolveAuthor(raw, index)
      if (seen.has(a.key)) continue
      seen.add(a.key)
      refs.push(a)
    }
    authorsOf.set(w.docId, refs)
  }

  // Retrieved works: best tier per work.
  const tierRank: Record<Tier, number> = { strong: 3, partial: 2, weak: 1 }
  const retrievedTier = new Map<string, Tier>()
  for (const r of opts.retrieved) {
    const w = byId.get(r.docId)
    if (!w) continue
    const cur = retrievedTier.get(w.docId)
    if (!cur || tierRank[r.tier] > tierRank[cur])
      retrievedTier.set(w.docId, r.tier)
  }
  const mode: RankResult['mode'] =
    retrievedTier.size === 0 || opts.likelyOffTopic ? 'topic_only' : 'evidence'
  if (mode === 'topic_only') retrievedTier.clear()

  // Candidate works: retrieved first, then tagged by matched topics (best cosine first).
  const candidateIds: string[] = [...retrievedTier.keys()]
  const bestCos = (w: WorkRow) =>
    Math.max(
      0,
      ...matched.filter((t) => w.topics.includes(t.label)).map((t) => t.cosine),
    )
  const tagged = works
    .filter(
      (w) =>
        !retrievedTier.has(w.docId) &&
        w.topics.some((t) => matchedLabels.has(t)),
    )
    .sort((a, b) => bestCos(b) - bestCos(a))
  for (const w of tagged) {
    if (candidateIds.length >= MAX_CANDIDATES) break
    candidateIds.push(w.docId)
  }

  // Corpus-wide per-person stats (corpusDocs, topic counts) — over every work.
  const corpusCount = new Map<string, number>()
  const topicCountsAll = new Map<string, Map<string, number>>()
  for (const w of works) {
    for (const a of authorsOf.get(w.docId)!) {
      if (a.org) continue
      corpusCount.set(a.key, (corpusCount.get(a.key) ?? 0) + 1)
      let tc = topicCountsAll.get(a.key)
      if (!tc) {
        tc = new Map()
        topicCountsAll.set(a.key, tc)
      }
      for (const t of new Set(w.topics)) tc.set(t, (tc.get(t) ?? 0) + 1)
    }
  }

  const people = new Map<string, PersonAcc>()
  const orgs = new Map<string, { name: string; docs: number }>()
  const acc = (a: AuthorRef): PersonAcc => {
    let p = people.get(a.key)
    if (!p) {
      p = {
        ref: a,
        evidence: 0,
        topic: 0,
        docIds: new Set(),
        retrievedDocs: 0,
        tiers: { strong: 0, partial: 0, weak: 0 },
        offices: {},
        years: [],
        topicCounts: topicCountsAll.get(a.key) ?? new Map(),
        corpusDocs: corpusCount.get(a.key) ?? 0,
      }
      people.set(a.key, p)
    }
    return p
  }

  for (const id of candidateIds) {
    const w = byId.get(id)!
    const tier = retrievedTier.get(w.docId) ?? null
    const authors = authorsOf.get(w.docId)!
    let personIndex = 0
    for (const a of authors) {
      if (a.org) {
        const o = orgs.get(a.key) ?? { name: a.name, docs: 0 }
        o.docs += 1
        orgs.set(a.key, o)
        continue
      }
      const p = acc(a)
      if (tier) {
        p.evidence +=
          TIER_W[tier] *
          (1 / (1 + POS_DECAY * personIndex)) *
          recencyWeight(w.year, currentYear)
        p.docIds.add(w.docId)
        p.tiers[tier] += 1
        if (w.year != null) p.years.push(w.year)
        p.offices[w.office ?? 'Office unknown'] =
          (p.offices[w.office ?? 'Office unknown'] ?? 0) + 1
      }
      personIndex += 1
    }
  }
  // Topic term over every candidate person, using corpus-wide topic counts.
  for (const p of people.values()) {
    for (const t of matched) {
      const n = p.topicCounts.get(t.label) ?? 0
      if (n > 0)
        p.topic += (t.cosine * specificity(t.df, N) * Math.min(n, 3)) / 3
    }
    // Freeze the retrieved count BEFORE the back-fill below: `evidence.docs`
    // is a retrieval claim and must stay 0 for a candidate with no retrieved
    // work, or the row reads "3 docs" beside "0 strong · 0 partial · 0 weak".
    // docIds still gets the topic works so the evidence panel has something to
    // show (ExpertsList already phrases that case as "N docs on these topics").
    p.retrievedDocs = p.docIds.size
    if (p.docIds.size === 0) {
      // topic-only person: office/years from their works on matched topics
      for (const w of works) {
        if (!w.topics.some((t) => matchedLabels.has(t))) continue
        if (!authorsOf.get(w.docId)!.some((a) => a.key === p.ref.key)) continue
        p.offices[w.office ?? 'Office unknown'] =
          (p.offices[w.office ?? 'Office unknown'] ?? 0) + 1
        if (w.year != null) p.years.push(w.year)
        p.docIds.add(w.docId)
      }
    }
  }

  const maxE = Math.max(0, ...[...people.values()].map((p) => p.evidence))
  const maxS = Math.max(0, ...[...people.values()].map((p) => p.topic))
  const scored = [...people.values()]
    .map((p) => {
      const e = maxE > 0 ? p.evidence / maxE : 0
      const s = maxS > 0 ? p.topic / maxS : 0
      const score =
        mode === 'evidence' ? EVIDENCE_WEIGHT * e + TOPIC_WEIGHT * s : s
      return { p, score }
    })
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) => b.score - a.score || a.p.ref.name.localeCompare(b.p.ref.name),
    )
  const maxScore = scored[0]?.score ?? 1

  const docs: Record<string, DocResult> = {}
  const addDoc = (id: string) => {
    if (docs[id]) return
    const w = byId.get(id)!
    docs[id] = {
      docId: w.docId,
      title: w.title,
      year: w.year,
      type: w.type,
      office: w.office,
      tier: retrievedTier.get(w.docId) ?? null,
      url: w.url,
      authors: authorsOf.get(w.docId)!,
      topics: w.topics,
      geographies: w.geographies,
      translations: w.translations,
    }
  }

  const results: PersonResult[] = scored.slice(0, topN).map(({ p, score }) => {
    const ids = [...p.docIds]
    ids.forEach(addDoc)
    const office =
      Object.entries(p.offices).sort((a, b) => b[1] - a[1])[0]?.[0] ??
      'Office unknown'
    const topics = [...p.topicCounts.entries()]
      .map(([label, n]) => ({ label, n, matched: matchedLabels.has(label) }))
      .sort(
        (a, b) =>
          Number(b.matched) - Number(a.matched) ||
          b.n - a.n ||
          a.label.localeCompare(b.label),
      )
    return {
      key: p.ref.key,
      name: p.ref.name,
      office,
      offices: p.offices,
      score: Number((score / maxScore).toFixed(4)),
      evidence: {
        docs: mode === 'evidence' ? p.retrievedDocs : 0,
        strong: p.tiers.strong,
        partial: p.tiers.partial,
        weak: p.tiers.weak,
        years: p.years.length
          ? [Math.min(...p.years), Math.max(...p.years)]
          : null,
        corpusDocs: p.corpusDocs,
      },
      topics,
      docIds: ids,
      ...(p.ref.unverified ? { unverified: true } : {}),
    }
  })

  return {
    mode,
    people: results,
    totalPeople: scored.length,
    docs,
    organizations: [...orgs.values()].sort(
      (a, b) => b.docs - a.docs || a.name.localeCompare(b.name),
    ),
    matchedTopics: matched,
  }
}
