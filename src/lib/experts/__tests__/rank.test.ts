// src/lib/experts/__tests__/rank.test.ts
import {
  rank,
  specificity,
  computeDf,
  MAX_CANDIDATES,
  DEFAULT_TOP_N,
  MAX_TOP_N,
} from '@/lib/experts/rank'
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
  work({
    docId: 'd1',
    authorsRaw: ['Xue, Lulu', 'Chen, Ke'],
    topics: ['Buses', 'Hub'],
    office: 'WRI China',
    year: 2025,
  }),
  work({
    docId: 'd2',
    authorsRaw: ['Xue, Lulu'],
    topics: ['Buses', 'Hub'],
    office: 'WRI China',
    year: 2018,
  }),
  work({
    docId: 'd3',
    authorsRaw: ['Sclar, Ryan', 'Coalition for Urban Transitions'],
    topics: ['School Buses', 'Hub'],
    year: 2023,
  }),
  work({
    docId: 'd4',
    authorsRaw: ['Lazer, Leah'],
    topics: ['Hub'],
    year: 2021,
  }),
  work({
    docId: 'd5',
    authorsRaw: ['Ryan Sclar'],
    topics: ['School Buses'],
    year: 2024,
    translations: ['d5-es'],
  }),
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
  const res = rank({
    works: WORKS,
    retrieved,
    matchedTopics: [
      { label: 'Buses', cosine: 0.6 },
      { label: 'Hub', cosine: 0.5 },
    ],
    currentYear: YEAR,
  })

  it('ranks the strong first author highest and normalizes to 1', () => {
    expect(res.mode).toBe('evidence')
    expect(res.people[0]).toMatchObject({
      key: 'xue, lulu',
      name: 'Xue, Lulu',
      score: 1,
    })
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
    expect(res.people.map((p) => p.key)).not.toContain(
      'coalition for urban transitions',
    )
    expect(res.organizations).toEqual([
      { name: 'Coalition for Urban Transitions', docs: 1 },
    ])
  })

  it('reports matched topics with df and flags them on people', () => {
    expect(res.matchedTopics).toEqual([
      { label: 'Buses', cosine: 0.6, df: 2 },
      { label: 'Hub', cosine: 0.5, df: 4 },
    ])
    const xue = res.people[0]
    expect(xue.topics.find((t) => t.label === 'Buses')).toEqual({
      label: 'Buses',
      n: 2,
      matched: true,
    })
  })

  it('includes tag-only candidates (no retrieved doc) via the topic term', () => {
    // d2's author is Xue (already in). Sclar has School Buses which is not matched.
    // Lazer authored only d4 (weak, retrieved). Chen appears via d1. So the
    // candidate from topic-space alone here is nobody new; assert the set.
    expect(res.people.map((p) => p.key).sort()).toEqual([
      'chen, ke',
      'lazer, leah',
      'sclar, ryan',
      'xue, lulu',
    ])
    expect(res.totalPeople).toBe(4)
  })

  it('honors excluded_topics for the topic term and matched list', () => {
    const r2 = rank({
      works: WORKS,
      retrieved,
      matchedTopics: [
        { label: 'Buses', cosine: 0.6 },
        { label: 'Hub', cosine: 0.5 },
      ],
      excludedTopics: ['Hub'],
      currentYear: YEAR,
    })
    expect(r2.matchedTopics.map((t) => t.label)).toEqual(['Buses'])
  })

  it('caps the list at topN but keeps totalPeople', () => {
    const r3 = rank({
      works: WORKS,
      retrieved,
      matchedTopics: [],
      currentYear: YEAR,
      topN: 2,
    })
    expect(r3.people).toHaveLength(2)
    expect(r3.totalPeople).toBe(4) // xue, chen (d1), sclar (d5 via d5-es), lazer (d4)
  })
})

describe('rank — topic_only mode', () => {
  it('falls back to topic space when nothing was retrieved', () => {
    const res = rank({
      works: WORKS,
      retrieved: [],
      matchedTopics: [{ label: 'School Buses', cosine: 0.7 }],
      currentYear: YEAR,
    })
    expect(res.mode).toBe('topic_only')
    expect(res.people[0].key).toBe('sclar, ryan')
    expect(res.people[0].score).toBe(1)
    expect(res.docs.d3.tier).toBeNull()
  })

  it('falls back when likely_off_topic even with retrieved docs', () => {
    const res = rank({
      works: WORKS,
      retrieved: [{ docId: 'd4', tier: 'weak', rank: 1 }],
      matchedTopics: [{ label: 'Buses', cosine: 0.7 }],
      likelyOffTopic: true,
      currentYear: YEAR,
    })
    expect(res.mode).toBe('topic_only')
    expect(res.people.map((p) => p.key)).toEqual(['xue, lulu', 'chen, ke'])
  })

  it('returns no people when both signals are empty', () => {
    const res = rank({
      works: WORKS,
      retrieved: [],
      matchedTopics: [],
      currentYear: YEAR,
    })
    expect(res.mode).toBe('topic_only')
    expect(res.people).toEqual([])
  })

  it('specificity keeps a hub topic from dominating the topic term', () => {
    const res = rank({
      works: WORKS,
      retrieved: [],
      matchedTopics: [
        { label: 'Hub', cosine: 0.9 },
        { label: 'School Buses', cosine: 0.5 },
      ],
      currentYear: YEAR,
    })
    // Sclar: 2 School Buses docs (df 2, spec ln(5/2)=0.92) * 0.5 * (2/3) ≈ 0.305 + Hub (1 doc) 0.9*ln(5/4)*(1/3)=0.067 → 0.37
    // Xue: Hub 2 docs → 0.9*0.223*(2/3)=0.134
    expect(res.people[0].key).toBe('sclar, ryan')
  })
})

// Spec §4.3. Each test below is built so that ONE factor is the only thing
// that can produce the asserted number: everything else in E(p)/S(p) is held
// constant across the people being compared. Reported `score` is
// score/maxScore, so what is pinned is the exact RATIO between two people —
// which is all the formula makes observable.
describe('§4.3 weights — exact values', () => {
  const scores = (res: { people: { key: string; score: number }[] }) =>
    Object.fromEntries(res.people.map((p) => [p.key, p.score]))

  it('tier_w: strong 1.0 · partial 0.5 · weak 0.15', () => {
    // Three sole authors, one work each, same year, same author index, no
    // topics at all (S(p) ≡ 0). Only tier_w differs.
    const res = rank({
      works: [
        work({ docId: 't1', authorsRaw: ['Strongly, Sam'] }),
        work({ docId: 't2', authorsRaw: ['Partly, Pat'] }),
        work({ docId: 't3', authorsRaw: ['Weakly, Wes'] }),
      ],
      retrieved: [
        { docId: 't1', tier: 'strong', rank: 1 },
        { docId: 't2', tier: 'partial', rank: 2 },
        { docId: 't3', tier: 'weak', rank: 3 },
      ],
      matchedTopics: [],
      currentYear: YEAR,
    })
    const s = scores(res)
    expect(s['strongly, sam']).toBe(1)
    expect(s['partly, pat']).toBe(0.5) // 0.5 / 1.0
    expect(s['weakly, wes']).toBe(0.15) // 0.15 / 1.0
  })

  it('pos_w: 1 / (1 + 0.3 · i), i = 0-based author index', () => {
    // One work, one tier, one year: position is the only difference.
    const res = rank({
      works: [
        work({
          docId: 'p1',
          authorsRaw: ['Firstly, Fay', 'Secondly, Sid', 'Thirdly, Tia'],
        }),
      ],
      retrieved: [{ docId: 'p1', tier: 'strong', rank: 1 }],
      matchedTopics: [],
      currentYear: YEAR,
    })
    const s = scores(res)
    expect(s['firstly, fay']).toBe(1) // 1/(1+0.3·0)
    expect(s['secondly, sid']).toBe(0.7692) // 1/(1+0.3·1) = 1/1.3
    expect(s['thirdly, tia']).toBe(0.625) // 1/(1+0.3·2) = 1/1.6
  })

  it('pos_w skips organizations when indexing people', () => {
    const res = rank({
      works: [
        work({
          docId: 'p2',
          authorsRaw: [
            'Firstly, Fay',
            'Coalition for Urban Transitions',
            'Secondly, Sid',
          ],
        }),
      ],
      retrieved: [{ docId: 'p2', tier: 'strong', rank: 1 }],
      matchedTopics: [],
      currentYear: YEAR,
    })
    // Sid is person index 1 (1/1.3), not row index 2 (1/1.6).
    expect(scores(res)['secondly, sid']).toBe(0.7692)
  })

  it('rec_w: ≥ current−3 → 1.0 · ≥ current−7 → 0.85 · older or null → 0.7', () => {
    // Sole authors, all strong, all index 0, no topics: only the year differs.
    const res = rank({
      works: [
        work({ docId: 'r1', authorsRaw: ['Recent, Rae'], year: YEAR - 3 }),
        work({ docId: 'r2', authorsRaw: ['Middle, Moe'], year: YEAR - 4 }),
        work({ docId: 'r3', authorsRaw: ['Edge, Eve'], year: YEAR - 7 }),
        work({ docId: 'r4', authorsRaw: ['Older, Ora'], year: YEAR - 8 }),
        work({ docId: 'r5', authorsRaw: ['Undated, Una'], year: null }),
      ],
      retrieved: [
        { docId: 'r1', tier: 'strong', rank: 1 },
        { docId: 'r2', tier: 'strong', rank: 2 },
        { docId: 'r3', tier: 'strong', rank: 3 },
        { docId: 'r4', tier: 'strong', rank: 4 },
        { docId: 'r5', tier: 'strong', rank: 5 },
      ],
      matchedTopics: [],
      currentYear: YEAR,
    })
    const s = scores(res)
    expect(s['recent, rae']).toBe(1)
    expect(s['middle, moe']).toBe(0.85)
    expect(s['edge, eve']).toBe(0.85) // current−7 is inside the 0.85 band
    expect(s['older, ora']).toBe(0.7)
    expect(s['undated, una']).toBe(0.7)
  })

  it('blends 0.7 · E/maxE + 0.3 · S/maxS', () => {
    // Eve: evidence only (her work carries no topic). Tom: topic only (his
    // work is tagged but not retrieved). Bea: both, and is the max on each
    // term, so her raw score is exactly 0.7 + 0.3 = 1 and normalization is a
    // no-op — which makes the other two report the weights themselves.
    const res = rank({
      works: [
        work({ docId: 'b1', authorsRaw: ['Evidence, Eve'], topics: [] }),
        work({ docId: 'b2', authorsRaw: ['Topical, Tom'], topics: ['T'] }),
        work({ docId: 'b3', authorsRaw: ['Both, Bea'], topics: ['T'] }),
      ],
      retrieved: [
        { docId: 'b1', tier: 'strong', rank: 1 },
        { docId: 'b3', tier: 'strong', rank: 2 },
      ],
      matchedTopics: [{ label: 'T', cosine: 0.6 }],
      currentYear: YEAR,
    })
    const s = scores(res)
    expect(s['both, bea']).toBe(1) // 0.7·1 + 0.3·1
    expect(s['evidence, eve']).toBe(0.7) // 0.7·1 + 0.3·0
    expect(s['topical, tom']).toBe(0.3) // 0.7·0 + 0.3·1
  })

  it('spec(t) = ln(N / df): df 4 of N 8 is worth ln(2)/ln(8) = 1/3 of df 1', () => {
    // N = 8 works. "Rare" is on 1, "Common" on 4. Ray and Cam each have
    // exactly one work on one topic, same cosine, same everything else — so
    // their score ratio IS spec(Common)/spec(Rare). topic_only mode, so the
    // evidence term is not in play at all.
    const res = rank({
      works: [
        work({ docId: 's1', authorsRaw: ['Rare, Ray'], topics: ['Rare'] }),
        work({ docId: 's2', authorsRaw: ['Common, Cam'], topics: ['Common'] }),
        work({ docId: 's3', authorsRaw: ['Filler, Al'], topics: ['Common'] }),
        work({ docId: 's4', authorsRaw: ['Filler, Bo'], topics: ['Common'] }),
        work({ docId: 's5', authorsRaw: ['Filler, Cy'], topics: ['Common'] }),
        work({ docId: 's6', authorsRaw: ['Filler, Di'], topics: [] }),
        work({ docId: 's7', authorsRaw: ['Filler, Ed'], topics: [] }),
        work({ docId: 's8', authorsRaw: ['Filler, Fi'], topics: [] }),
      ],
      retrieved: [],
      matchedTopics: [
        { label: 'Rare', cosine: 0.5 },
        { label: 'Common', cosine: 0.5 },
      ],
      currentYear: YEAR,
    })
    expect(res.mode).toBe('topic_only')
    expect(res.matchedTopics).toEqual([
      { label: 'Rare', cosine: 0.5, df: 1 },
      { label: 'Common', cosine: 0.5, df: 4 },
    ])
    const s = scores(res)
    expect(s['rare, ray']).toBe(1)
    expect(s['common, cam']).toBe(0.3333) // ln(8/4) / ln(8/1)
  })
})

// Spec §4.1: "a work's authors are the union of its rows' authors (keyed per
// §6)". expertsEvidence dedupes the union with an exact-string Set, so a
// translation storing `Lulu Xue` alongside the original's `Xue, Lulu` survives
// into authorsRaw. Both resolve to the same key, so within ONE work the same
// accumulator was hit twice — and the phantom entry shifted every later
// co-author's position index.
describe('duplicate author forms within one work', () => {
  const DUP: WorkRow[] = [
    work({
      docId: 'w1',
      authorsRaw: ['Xue, Lulu', 'Lulu Xue', 'Chen, Ke'],
      topics: ['T'],
      year: 2025,
    }),
  ]
  const retrieved: RetrievedDoc[] = [{ docId: 'w1', tier: 'strong', rank: 1 }]

  it('counts a person once per work, not once per row form', () => {
    const res = rank({
      works: DUP,
      retrieved,
      matchedTopics: [{ label: 'T', cosine: 0.6 }],
      currentYear: YEAR,
    })
    const xue = res.people.find((p) => p.key === 'xue, lulu')!
    expect(xue.evidence).toMatchObject({
      docs: 1,
      strong: 1,
      partial: 0,
      weak: 0,
      corpusDocs: 1,
    })
    expect(xue.evidence.years).toEqual([2025, 2025])
    expect(xue.offices).toEqual({ 'WRI Global': 1 }) // one tally, not two
    expect(xue.topics.find((t) => t.label === 'T')).toEqual({
      label: 'T',
      n: 1,
      matched: true,
    })
    expect(res.people).toHaveLength(2) // Xue and Chen, no phantom third
  })

  it('does not let the phantom entry demote the next real co-author', () => {
    const res = rank({
      works: DUP,
      retrieved,
      matchedTopics: [],
      currentYear: YEAR,
    })
    // Chen is person index 1 (1/1.3), not index 2 (1/1.6) as the duplicate
    // form made him.
    const s = Object.fromEntries(res.people.map((p) => [p.key, p.score]))
    expect(s['xue, lulu']).toBe(1)
    expect(s['chen, ke']).toBe(0.7692)
  })
})

// R6/R7. In evidence mode a candidate with NO retrieved doc has its docIds
// back-filled from its topic-matched works so the evidence panel has something
// to show. Reporting that back-filled count as `evidence.docs` made the row
// read "3 docs" next to "0 strong · 0 partial · 0 weak" — a retrieval claim
// for someone with zero retrieval evidence.
describe('tag-only candidate in evidence mode', () => {
  const WORKS_TAGONLY: WorkRow[] = [
    work({ docId: 'e1', authorsRaw: ['Retrieved, Rita'], topics: ['T'] }),
    work({
      docId: 'e2',
      authorsRaw: ['Tagged, Tom'],
      topics: ['T'],
      year: 2020,
      office: 'WRI India',
    }),
    work({
      docId: 'e3',
      authorsRaw: ['Tagged, Tom'],
      topics: ['T'],
      year: 2022,
      office: 'WRI India',
    }),
    // Filler so df('T') = 3 < N = 6 and spec('T') = ln(2) > 0; with df = N the
    // topic term is identically zero and nobody is scored from topic space.
    work({ docId: 'f1', authorsRaw: ['Filler, Fay'] }),
    work({ docId: 'f2', authorsRaw: ['Filler, Fay'] }),
    work({ docId: 'f3', authorsRaw: ['Filler, Fay'] }),
  ]
  const res = rank({
    works: WORKS_TAGONLY,
    retrieved: [{ docId: 'e1', tier: 'strong', rank: 1 }],
    matchedTopics: [{ label: 'T', cosine: 0.6 }],
    currentYear: YEAR,
  })
  const tom = () => res.people.find((p) => p.key === 'tagged, tom')!

  it('is a candidate and is scored from topic space', () => {
    expect(res.mode).toBe('evidence')
    expect(res.people.map((p) => p.key)).toEqual([
      'retrieved, rita',
      'tagged, tom',
    ])
    // Tom 0.7·0 + 0.3·1 = 0.3, over Rita's max 0.7·1 + 0.3·0.5 = 0.85.
    expect(tom().score).toBe(0.3529)
  })

  it('reports zero retrieved docs rather than the back-filled count', () => {
    expect(tom().evidence).toMatchObject({
      docs: 0,
      strong: 0,
      partial: 0,
      weak: 0,
      corpusDocs: 2,
    })
  })

  it('still carries the topic works in docIds so the evidence panel is not empty', () => {
    expect([...tom().docIds].sort()).toEqual(['e2', 'e3'])
    expect(res.docs.e2).toMatchObject({ docId: 'e2', tier: null })
    expect(res.docs.e3).toMatchObject({ docId: 'e3', tier: null })
    // office and years come from those same works
    expect(tom().office).toBe('WRI India')
    expect(tom().offices).toEqual({ 'WRI India': 2 })
    expect(tom().evidence.years).toEqual([2020, 2022])
  })

  it('leaves a retrieved person’s count alone', () => {
    const rita = res.people.find((p) => p.key === 'retrieved, rita')!
    expect(rita.evidence).toMatchObject({ docs: 1, strong: 1 })
    expect(rita.docIds).toEqual(['e1'])
  })
})

// R8. §4.2 caps candidates at 300 (retrieved first, then tagged works by
// descending best matched cosine); §5.1 caps top_n at 50, default 20.
describe('candidate and topN caps', () => {
  // c0 is retrieved; c1..c350 are tagged only. The z-works carry no topic so
  // df('T') < N and spec('T') > 0 (with df = N the topic term is zero and
  // nobody past the retrieved work would score at all).
  const BIG: WorkRow[] = [
    work({ docId: 'c0', authorsRaw: ['Ret, R'], topics: ['T'] }),
    ...Array.from({ length: 350 }, (_, i) =>
      work({ docId: `c${i + 1}`, authorsRaw: [`A${i + 1}, X`], topics: ['T'] }),
    ),
    ...Array.from({ length: 100 }, (_, i) =>
      work({ docId: `z${i + 1}`, authorsRaw: ['Zed, Z'] }),
    ),
  ]
  const run = (topN?: number) =>
    rank({
      works: BIG,
      retrieved: [{ docId: 'c0', tier: 'strong', rank: 1 }],
      matchedTopics: [{ label: 'T', cosine: 0.6 }],
      currentYear: YEAR,
      topN,
    })

  it('stops taking tagged works at MAX_CANDIDATES', () => {
    const res = run(MAX_TOP_N)
    // 1 retrieved + 299 tagged = 300 candidate works, one sole author each,
    // so the candidate cap is directly visible as the person total.
    expect(res.totalPeople).toBe(MAX_CANDIDATES)
    expect(res.totalPeople).toBeLessThan(BIG.length)
    const keys = res.people.map((p) => p.key)
    expect(keys).toContain('ret, r') // the retrieved work is taken first
    // authors of tagged works past the cap never become candidates at all
    expect(keys).not.toContain('a350, x')
    const cappedOut = rank({
      works: BIG,
      retrieved: [{ docId: 'c0', tier: 'strong', rank: 1 }],
      matchedTopics: [{ label: 'T', cosine: 0.6 }],
      currentYear: YEAR,
      topN: MAX_TOP_N,
    })
    expect(cappedOut.people.map((p) => p.key)).toEqual(keys) // deterministic
  })

  it('clamps topN to [1, 50] and defaults to 20', () => {
    expect(run(undefined).people).toHaveLength(DEFAULT_TOP_N)
    expect(run(999).people).toHaveLength(MAX_TOP_N)
    expect(run(51).people).toHaveLength(MAX_TOP_N)
    expect(run(0).people).toHaveLength(1)
    expect(run(-5).people).toHaveLength(1)
    expect(run(7).people).toHaveLength(7)
    // the cap never touches the reported total
    expect(run(1).totalPeople).toBe(300)
  })
})
