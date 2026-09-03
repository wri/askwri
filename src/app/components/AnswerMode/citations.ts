import type { DocMeta, KP } from '@/lib/llamacloud'
import type { InlineRef, PassageSent } from './types'

/** The key SupportingCitations and CitationCard already use per passage. */
export function passageKey(docId: string, passageId: string): string {
  return `${docId}:${passageId}`
}

/**
 * Turn the model's per-sentence cite ids into the passages they name. Ids
 * were validated server-side against passages_sent; an id that still fails to
 * resolve here (should not happen) is skipped rather than guessed.
 */
export function buildInline(
  cites: number[][],
  passagesSent: PassageSent[],
  docs: DocMeta[],
): InlineRef[][] {
  const byId = new Map(passagesSent.map((p) => [p.id, p]))
  const refByDoc = new Map(docs.map((d) => [d.doc_id, d.ref]))
  return cites.map((ids) =>
    ids.flatMap((id) => {
      const p = byId.get(id)
      if (!p) return []
      return [
        {
          ref: refByDoc.get(p.doc_id) ?? p.doc_id,
          page: p.page,
          passage_id: passageKey(p.doc_id, p.chunk_id),
          doc_id: p.doc_id,
        },
      ]
    }),
  )
}

export function citedDocCount(inline: InlineRef[][] | undefined): number {
  if (!inline) return 0
  return new Set(inline.flat().map((r) => r.doc_id)).size
}

export interface CitationItem {
  doc: DocMeta
  kp: KP
  /** "s.j" of the first sentence/citation that cites this passage; undefined when uncited. */
  label?: string
}

/**
 * The order the Sources panel renders: every cited passage first, in the
 * order it is first cited, then every other retrieved passage by relevance.
 * indexByPassageId is what a citation marker uses to scroll to its passage.
 */
export function orderCitationItems(
  docs: DocMeta[],
  inline: InlineRef[][] | undefined,
): {
  items: CitationItem[]
  citedCount: number
  indexByPassageId: Record<string, number>
} {
  const all: CitationItem[] = []
  for (const d of docs) {
    for (const kp of d.kps ?? []) all.push({ doc: d, kp })
  }
  const byKey = new Map(
    all.map((it) => [passageKey(it.doc.doc_id, it.kp.passage_id), it]),
  )

  const cited: CitationItem[] = []
  const citedKeys = new Set<string>()
  ;(inline ?? []).forEach((refs, s) => {
    refs.forEach((r, j) => {
      if (citedKeys.has(r.passage_id)) return
      const it = byKey.get(r.passage_id)
      if (!it) return
      citedKeys.add(r.passage_id)
      cited.push({ ...it, label: `${s + 1}.${j + 1}` })
    })
  })

  const rest = all
    .filter((it) => !citedKeys.has(passageKey(it.doc.doc_id, it.kp.passage_id)))
    .sort((a, b) => b.kp.kp_relevance - a.kp.kp_relevance)

  const items = [...cited, ...rest]
  const indexByPassageId: Record<string, number> = {}
  items.forEach((it, i) => {
    indexByPassageId[passageKey(it.doc.doc_id, it.kp.passage_id)] = i
  })
  return { items, citedCount: cited.length, indexByPassageId }
}
