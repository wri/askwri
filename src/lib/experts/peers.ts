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

/** `corpusWorks` is the count of searchable WORKS (spec §4.5's N), NOT the
 *  payload doc count — matched_topics[].df is corpus-wide, so specificity
 *  ln(N/df) goes negative for hub topics if a caller passes the smaller number
 *  and every peer silently disappears. Named to be un-confusable with the
 *  page's `totalWorks`, which IS the payload count. */
export function peersOf(
  person: PersonResult,
  others: PersonResult[],
  matched: MatchedTag[],
  corpusWorks: number,
): Peer[] {
  const mine = new Map(person.topics.map((t) => [t.label, t.n]))
  const spec = new Map(
    matched.map((t) => [t.label, specificity(t.df, corpusWorks)]),
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
