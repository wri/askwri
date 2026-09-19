// Static, seeded force layout (spec §8): computed once per result set, no
// animation. Radii and forces mirror the mockup.
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force'
import type { MatchedTag, PersonResult } from './types'

export interface LayoutNode {
  id: string
  kind: 'person' | 'topic'
  key: string // person key or topic label
  r: number
  x: number
  y: number
}
export interface LayoutLink {
  source: string
  target: string
  w: number
}

const TICKS = 360

/** A missing or NaN strength must not poison the layout. For a topic cosine,
 *  one bad value in `Math.max(...)` makes maxCos NaN, so every topic radius —
 *  and then every simulated coordinate — is NaN and the graph disappears. For
 *  a person score it is worse: the NaN radius becomes that node's own clamp
 *  bound below, and `Math.max(NaN, …)` is NaN however finite the coordinate. */
function finiteOrZero(c: number | undefined | null): number {
  return typeof c === 'number' && Number.isFinite(c) ? c : 0
}

/** Clamp that also absorbs a NaN: plain Math.max/Math.min PROPAGATE NaN. */
function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

/** Small deterministic PRNG (mulberry32) so layouts are reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function buildGraph(people: PersonResult[], matched: MatchedTag[]) {
  const nodes: Omit<LayoutNode, 'x' | 'y'>[] = []
  const links: LayoutLink[] = []
  for (const p of people)
    nodes.push({
      id: `p:${p.key}`,
      kind: 'person',
      key: p.key,
      r: 7 + 13 * finiteOrZero(p.score),
    })
  const maxCos = Math.max(0.01, ...matched.map((t) => finiteOrZero(t.cosine)))
  for (const t of matched)
    nodes.push({
      id: `t:${t.label}`,
      kind: 'topic',
      key: t.label,
      r: 9 + 18 * (finiteOrZero(t.cosine) / maxCos),
    })
  const matchedSet = new Set(matched.map((t) => t.label))
  for (const p of people) {
    for (const t of p.topics) {
      if (matchedSet.has(t.label) && t.n > 0)
        links.push({ source: `p:${p.key}`, target: `t:${t.label}`, w: t.n })
    }
  }
  return { nodes, links }
}

export function computeLayout(
  people: PersonResult[],
  matched: MatchedTag[],
  width: number,
  height: number,
  seed = 1,
) {
  const g = buildGraph(people, matched)
  type SimNode = LayoutNode & { vx?: number; vy?: number }
  const nodes: SimNode[] = g.nodes.map((n) => ({
    ...n,
    x: width / 2,
    y: height / 2,
  }))
  const links = g.links.map((l) => ({ ...l }))
  const sim = forceSimulation<SimNode>(nodes)
    .randomSource(mulberry32(seed))
    .force(
      'link',
      forceLink<SimNode, { source: string; target: string; w: number }>(
        links as any,
      )
        .id((d) => d.id)
        .distance((l) => 96 - 8 * Math.min(l.w, 5))
        .strength((l) => 0.25 + 0.1 * Math.min(l.w, 4)),
    )
    .force(
      'charge',
      forceManyBody<SimNode>().strength((d) =>
        d.kind === 'topic' ? -900 : -260,
      ),
    )
    .force(
      'collide',
      forceCollide<SimNode>()
        .radius((d) => d.r + (d.kind === 'topic' ? 48 : 34))
        .iterations(2),
    )
    .force('center', forceCenter(width / 2, height / 2))
    .force('x', forceX(width / 2).strength(0.05))
    .force('y', forceY(height / 2).strength(0.07))
    .stop()
  for (let i = 0; i < TICKS; i += 1) sim.tick()
  const out: LayoutNode[] = nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    key: n.key,
    r: n.r,
    x: clamp(n.x, n.r + 70, width - n.r - 110),
    y: clamp(n.y, n.r + 16, height - n.r - 16),
  }))
  return { nodes: out, links: g.links }
}
