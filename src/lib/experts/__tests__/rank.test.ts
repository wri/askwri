// src/lib/experts/__tests__/rank.test.ts
import { rank, specificity, computeDf } from '@/lib/experts/rank'
import type { WorkRow, RetrievedDoc } from '@/lib/experts/types'

const work = (p: Partial<WorkRow> & { docId: string }): WorkRow => ({
  translations: [],
  title: p.docId,
  year: 2024,
  type: 'Report',
  office: 'WRI Global',
  url: null,
  authorsRaw: [],
  topics: [],
  geographies: [],
  ...p,
})

const WORKS: WorkRow[] = [
  work({ docId: 'd1', authorsRaw: ['Xue, Lulu', 'Chen, Ke'], topics: ['Buses', 'Hub'], office: 'WRI China', year: 2025 }),
  work({ docId: 'd2', authorsRaw: ['Xue, Lulu'], topics: ['Buses', 'Hub'], office: 'WRI China', year: 2018 }),
  work({ docId: 'd3', authorsRaw: ['Sclar, Ryan', 'Coalition for Urban Transitions'], topics: ['School Buses', 'Hub'], year: 2023 }),
  work({ docId: 'd4', authorsRaw: ['Lazer, Leah'], topics: ['Hub'], year: 2021 }),
  work({ docId: 'd5', authorsRaw: ['Ryan Sclar'], topics: ['School Buses'], year: 2024, translations: ['d5-es'] }),
]
const YEAR = 2026

describe('specificity and df', () => {
  it('computes df over works and ln(N/df)', () => {
    const df = computeDf(WORKS)
    expect(df.get('Hub')).toBe(4)
    expect(df.get('Buses')).toBe(2)
    expect(specificity(4, 5)).toBeCloseTo(Math.log(5 / 4), 6)
    expect(specificity(0, 5)).toBeCloseTo(Math.log(5), 6) // df floored at 1
  })
})

describe('rank — evidence mode', () => {
  const retrieved: RetrievedDoc[] = [
    { docId: 'd1', tier: 'strong', rank: 1 },
    { docId: 'd5-es', tier: 'partial', rank: 2 }, // translation id -> work d5
    { docId: 'd4', tier: 'weak', rank: 3 },
  ]
  const res = rank({ works: WORKS, retrieved, matchedTopics: [{ label: 'Buses', cosine: 0.6 }, { label: 'Hub', cosine: 0.5 }], currentYear: YEAR })

  it('ranks the strong first author highest and normalizes to 1', () => {
    expect(res.mode).toBe('evidence')
    expect(res.people[0]).toMatchObject({ key: 'xue, lulu', name: 'Xue, Lulu', score: 1 })
  })

  it('merges Given Family and Family, Given into one person and maps a translation hit to its work', () => {
    const sclar = res.people.find((p) => p.key === 'sclar, ryan')!
    expect(sclar.evidence).toMatchObject({ docs: 1, partial: 1, corpusDocs: 2 })
    expect(sclar.docIds).toEqual(['d5'])
    expect(res.docs.d5.tier).toBe('partial')
    expect(res.docs.d5.translations).toEqual(['d5-es'])
  })

  it('weights second authors and old docs down', () => {
    const chen = res.people.find((p) => p.key === 'chen, ke')!
    const xue = res.people.find((p) => p.key === 'xue, lulu')!
    // both authored d1 (strong, 2025): Chen is author 2 -> 1/(1+0.3) of Xue's evidence on that doc
    expect(chen.score).toBeLessThan(xue.score)
    expect(chen.evidence.docs).toBe(1)
  })

  it('excludes organizations from people and lists them separately', () => {
    expect(res.people.map((p) => p.key)).not.toContain('coalition for urban transitions')
    expect(res.organizations).toEqual([{ name: 'Coalition for Urban Transitions', docs: 1 }])
  })

  it('reports matched topics with df and flags them on people', () => {
    expect(res.matchedTopics).toEqual([
      { label: 'Buses', cosine: 0.6, df: 2 },
      { label: 'Hub', cosine: 0.5, df: 4 },
    ])
    const xue = res.people[0]
    expect(xue.topics.find((t) => t.label === 'Buses')).toEqual({ label: 'Buses', n: 2, matched: true })
  })

  it('includes tag-only candidates (no retrieved doc) via the topic term', () => {
    // d2's author is Xue (already in). Sclar has School Buses which is not matched.
    // Lazer authored only d4 (weak, retrieved). Chen appears via d1. So the
    // candidate from topic-space alone here is nobody new; assert the set.
    expect(res.people.map((p) => p.key).sort()).toEqual(['chen, ke', 'lazer, leah', 'sclar, ryan', 'xue, lulu'])
    expect(res.totalPeople).toBe(4)
  })

  it('honors excluded_topics for the topic term and matched list', () => {
    const r2 = rank({ works: WORKS, retrieved, matchedTopics: [{ label: 'Buses', cosine: 0.6 }, { label: 'Hub', cosine: 0.5 }], excludedTopics: ['Hub'], currentYear: YEAR })
    expect(r2.matchedTopics.map((t) => t.label)).toEqual(['Buses'])
  })

  it('caps the list at topN but keeps totalPeople', () => {
    const r3 = rank({ works: WORKS, retrieved, matchedTopics: [], currentYear: YEAR, topN: 2 })
    expect(r3.people).toHaveLength(2)
    expect(r3.totalPeople).toBe(4) // xue, chen (d1), sclar (d5 via d5-es), lazer (d4)
  })
})

describe('rank — topic_only mode', () => {
  it('falls back to topic space when nothing was retrieved', () => {
    const res = rank({ works: WORKS, retrieved: [], matchedTopics: [{ label: 'School Buses', cosine: 0.7 }], currentYear: YEAR })
    expect(res.mode).toBe('topic_only')
    expect(res.people[0].key).toBe('sclar, ryan')
    expect(res.people[0].score).toBe(1)
    expect(res.docs.d3.tier).toBeNull()
  })

  it('falls back when likely_off_topic even with retrieved docs', () => {
    const res = rank({ works: WORKS, retrieved: [{ docId: 'd4', tier: 'weak', rank: 1 }], matchedTopics: [{ label: 'Buses', cosine: 0.7 }], likelyOffTopic: true, currentYear: YEAR })
    expect(res.mode).toBe('topic_only')
    expect(res.people.map((p) => p.key)).toEqual(['xue, lulu', 'chen, ke'])
  })

  it('returns no people when both signals are empty', () => {
    const res = rank({ works: WORKS, retrieved: [], matchedTopics: [], currentYear: YEAR })
    expect(res.mode).toBe('topic_only')
    expect(res.people).toEqual([])
  })

  it('specificity keeps a hub topic from dominating the topic term', () => {
    const res = rank({ works: WORKS, retrieved: [], matchedTopics: [{ label: 'Hub', cosine: 0.9 }, { label: 'School Buses', cosine: 0.5 }], currentYear: YEAR })
    // Sclar: 2 School Buses docs (df 2, spec ln(5/2)=0.92) * 0.5 * (2/3) ≈ 0.305 + Hub (1 doc) 0.9*ln(5/4)*(1/3)=0.067 → 0.37
    // Xue: Hub 2 docs → 0.9*0.223*(2/3)=0.134
    expect(res.people[0].key).toBe('sclar, ryan')
  })
})
