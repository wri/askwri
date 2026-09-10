import { buildGraph, computeLayout } from '@/lib/experts/layout'
import type { MatchedTag, PersonResult } from '@/lib/experts/types'

const p = (
  key: string,
  score: number,
  topics: Record<string, number>,
): PersonResult => ({
  key,
  name: key,
  office: 'WRI Global',
  offices: {},
  score,
  evidence: {
    docs: 1,
    strong: 1,
    partial: 0,
    weak: 0,
    years: null,
    corpusDocs: 1,
  },
  topics: Object.entries(topics).map(([label, n]) => ({
    label,
    n,
    matched: true,
  })),
  docIds: [],
})
const people = [
  p('a', 1, { Buses: 3, Hub: 1 }),
  p('b', 0.5, { Hub: 2 }),
  p('c', 0.2, { Buses: 1 }),
]
const matched: MatchedTag[] = [
  { label: 'Buses', cosine: 0.66, df: 19 },
  { label: 'Hub', cosine: 0.3, df: 145 },
]

describe('buildGraph', () => {
  it('creates person and topic nodes and weighted person->topic links', () => {
    const g = buildGraph(people, matched)
    expect(g.nodes.map((n) => n.id)).toEqual([
      'p:a',
      'p:b',
      'p:c',
      't:Buses',
      't:Hub',
    ])
    expect(g.links).toEqual([
      { source: 'p:a', target: 't:Buses', w: 3 },
      { source: 'p:a', target: 't:Hub', w: 1 },
      { source: 'p:b', target: 't:Hub', w: 2 },
      { source: 'p:c', target: 't:Buses', w: 1 },
    ])
    const a = g.nodes.find((n) => n.id === 'p:a')!
    const c = g.nodes.find((n) => n.id === 'p:c')!
    expect(a.r).toBeGreaterThan(c.r)
  })
})

describe('computeLayout', () => {
  it('is deterministic for a fixed seed and keeps nodes inside the frame', () => {
    const one = computeLayout(people, matched, 900, 600, 7)
    const two = computeLayout(people, matched, 900, 600, 7)
    expect(one.nodes.map((n) => [n.x, n.y])).toEqual(
      two.nodes.map((n) => [n.x, n.y]),
    )
    for (const n of one.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x).toBeLessThanOrEqual(900)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeLessThanOrEqual(600)
    }
  })

  it('changes with the seed', () => {
    const one = computeLayout(people, matched, 900, 600, 1)
    const two = computeLayout(people, matched, 900, 600, 2)
    expect(one.nodes.map((n) => n.x)).not.toEqual(two.nodes.map((n) => n.x))
  })
})

describe('computeLayout with missing or NaN topic strengths (U15)', () => {
  const brokenMatched = [
    { label: 'Buses', cosine: NaN, df: 19 },
    { label: 'Hub', cosine: undefined as unknown as number, df: 145 },
  ] as MatchedTag[]

  it('gives every node a finite radius when a cosine is NaN or missing', () => {
    const g = buildGraph(people, brokenMatched)
    for (const n of g.nodes) expect(Number.isFinite(n.r)).toBe(true)
  })

  it('never emits NaN coordinates, and keeps nodes inside the frame', () => {
    const { nodes } = computeLayout(people, brokenMatched, 900, 600, 7)
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x).toBeLessThanOrEqual(900)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeLessThanOrEqual(600)
    }
  })

  it('still ranks a real cosine above a missing one', () => {
    const mixed = [
      { label: 'Buses', cosine: 0.66, df: 19 },
      { label: 'Hub', cosine: NaN, df: 145 },
    ] as MatchedTag[]
    const g = buildGraph(people, mixed)
    const buses = g.nodes.find((n) => n.id === 't:Buses')!
    const hub = g.nodes.find((n) => n.id === 't:Hub')!
    expect(buses.r).toBeGreaterThan(hub.r)
  })

  it('survives a person whose score is missing or NaN', () => {
    // A NaN person radius is worse than a NaN topic radius: r becomes the `lo`
    // bound of that node's own clamp, and Math.max(NaN, …) is NaN however
    // finite the coordinate is. Guarding the value alone is not enough.
    const brokenPeople = [
      { ...people[0], score: NaN },
      { ...people[1], score: undefined as unknown as number },
    ]
    const g = buildGraph(brokenPeople, matched)
    for (const n of g.nodes) expect(Number.isFinite(n.r)).toBe(true)
    const { nodes } = computeLayout(brokenPeople, matched, 900, 600, 7)
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
    }
  })
})
