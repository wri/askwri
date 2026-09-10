// src/lib/experts/__tests__/peers.test.ts
import { peersOf, PEER_THRESHOLD } from '@/lib/experts/peers'
import type { MatchedTag, PersonResult } from '@/lib/experts/types'

const person = (key: string, topics: Record<string, number>): PersonResult => ({
  key, name: key, office: 'WRI Global', offices: {}, score: 1,
  evidence: { docs: 0, strong: 0, partial: 0, weak: 0, years: null, corpusDocs: 0 },
  topics: Object.entries(topics).map(([label, n]) => ({ label, n, matched: true })),
  docIds: [],
})
const N = 201
const matched: MatchedTag[] = [
  { label: 'Hub', cosine: 0.9, df: 145 }, // spec ln(201/145)=0.33
  { label: 'School Buses', cosine: 0.5, df: 10 }, // spec 3.0
  { label: 'Buses', cosine: 0.6, df: 19 }, // spec 2.36
]

describe('peersOf', () => {
  it('weights shared topics by specificity and thresholds', () => {
    const a = person('a', { Hub: 5, 'School Buses': 2, Buses: 1 })
    const hubOnly = person('b', { Hub: 5 })
    const specific = person('c', { 'School Buses': 2 })
    const out = peersOf(a, [hubOnly, specific], matched, N)
    // b: min(5,5)*0.33 = 1.63 < threshold; c: 2*3.0 = 6.0 >= threshold
    expect(out.map((p) => p.key)).toEqual(['c'])
    expect(out[0].shared).toBeCloseTo(6.0, 1)
    expect(out[0].topics).toEqual(['School Buses'])
  })

  it('lists shared topics most-specific first and sorts peers by shared', () => {
    const a = person('a', { Hub: 3, 'School Buses': 1, Buses: 2 })
    const b = person('b', { Buses: 2, 'School Buses': 1, Hub: 3 }) // 2*2.36+1*3+3*0.33 = 8.7
    const c = person('c', { 'School Buses': 1, Buses: 1 }) // 3+2.36 = 5.36
    const out = peersOf(a, [b, c], matched, N)
    expect(out.map((p) => p.key)).toEqual(['b', 'c'])
    expect(out[0].topics).toEqual(['School Buses', 'Buses', 'Hub'])
  })

  it('never returns the person themself', () => {
    const a = person('a', { 'School Buses': 3 })
    expect(peersOf(a, [a], matched, N)).toEqual([])
  })

  it('exposes the prototype threshold', () => {
    expect(PEER_THRESHOLD).toBe(4.5)
  })
})
