// src/lib/experts/peers.ts
// Peers (spec §4.5): specificity-weighted shared matched topics. Shared by
// the page (graph highlight, "works alongside") — pure, no I/O.
import { specificity } from './rank'
import type { MatchedTag, PersonResult } from './types'

// PROTOTYPE DEFAULT (4.5 from the mockup). No labeled set yet; raising it
// empties the peer list for people with one matched topic, lowering it makes
// hub topics connect everyone again. Derive from labeled queries before tuning.
export const PEER_THRESHOLD = 4.5

export interface Peer {
  key: string
  name: string
  shared: number
  topics: string[]
}

export function peersOf(
  person: PersonResult,
  others: PersonResult[],
  matched: MatchedTag[],
  totalWorks: number,
): Peer[] {
  const mine = new Map(person.topics.map((t) => [t.label, t.n]))
  const spec = new Map(
    matched.map((t) => [t.label, specificity(t.df, totalWorks)]),
  )
  const out: Peer[] = []
  for (const q of others) {
    if (q.key === person.key) continue
    let shared = 0
    const topics: string[] = []
    for (const t of q.topics) {
      const s = spec.get(t.label)
      const n = mine.get(t.label)
      if (s === undefined || !n || !t.n) continue
      shared += Math.min(n, t.n) * s
      topics.push(t.label)
    }
    if (shared >= PEER_THRESHOLD) {
      topics.sort((a, b) => (spec.get(b) ?? 0) - (spec.get(a) ?? 0))
      out.push({ key: q.key, name: q.name, shared, topics })
    }
  }
  return out.sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name))
}
