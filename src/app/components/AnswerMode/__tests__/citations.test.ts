import { buildInline, citedDocCount, orderCitationItems } from '../citations'
import type { DocMeta } from '@/lib/llamacloud'
import type { PassageSent } from '../types'

function doc(docId: string, passages: Array<[string, number]>): DocMeta {
  return {
    doc_id: docId,
    ref: docId.replace(/[^a-z0-9]+/gi, '_'),
    title: docId,
    kps: passages.map(([pid, rel]) => ({
      kp_relevance: rel,
      snippet: `text of ${pid}`,
      passage_id: pid,
      page: 1,
      citation_targets: [],
    })),
  }
}

const docs: DocMeta[] = [
  doc('A', [['A_chunk_1', 0.9]]),
  doc('B', [['B_chunk_7', 0.8]]),
  doc('C', [['C_chunk_2', 0.7]]),
]
const sent: PassageSent[] = [
  { id: 1, doc_id: 'A', chunk_id: 'A_chunk_1', page: 3, text: 't1' },
  { id: 2, doc_id: 'B', chunk_id: 'B_chunk_7', page: 9, text: 't2' },
  { id: 3, doc_id: 'C', chunk_id: 'C_chunk_2', page: 1, text: 't3' },
]

describe('buildInline', () => {
  it('maps cite ids to the passage sent, with the doc ref and page', () => {
    const inline = buildInline([[2], [1, 3]], sent, docs)
    expect(inline).toEqual([
      [{ ref: 'B', page: 9, passage_id: 'B:B_chunk_7', doc_id: 'B' }],
      [
        { ref: 'A', page: 3, passage_id: 'A:A_chunk_1', doc_id: 'A' },
        { ref: 'C', page: 1, passage_id: 'C:C_chunk_2', doc_id: 'C' },
      ],
    ])
  })

  it('ignores ids with no passage and keeps one entry per sentence', () => {
    expect(buildInline([[9], []], sent, docs)).toEqual([[], []])
  })
})

describe('citedDocCount', () => {
  it('counts distinct documents across all sentences', () => {
    const inline = buildInline(
      [
        [1, 2],
        [1, 3],
      ],
      sent,
      docs,
    )
    expect(citedDocCount(inline)).toBe(3)
    expect(citedDocCount(buildInline([[1], [1]], sent, docs))).toBe(1)
    expect(citedDocCount(undefined)).toBe(0)
  })
})

describe('orderCitationItems', () => {
  it('lists cited passages first in first-citation order, then the rest by relevance', () => {
    const inline = buildInline([[3], [1, 3]], sent, docs)
    const { items, citedCount, indexByPassageId } = orderCitationItems(
      docs,
      inline,
    )
    expect(items.map((i) => i.kp.passage_id)).toEqual([
      'C_chunk_2',
      'A_chunk_1',
      'B_chunk_7',
    ])
    expect(citedCount).toBe(2)
    expect(items[0].label).toBe('1.1')
    expect(items[1].label).toBe('2.1')
    expect(items[2].label).toBeUndefined()
    expect(indexByPassageId['C:C_chunk_2']).toBe(0)
    expect(indexByPassageId['A:A_chunk_1']).toBe(1)
    expect(indexByPassageId['B:B_chunk_7']).toBe(2)
  })

  it('with no inline, everything is uncited and sorted by relevance', () => {
    const { items, citedCount } = orderCitationItems(docs, undefined)
    expect(items.map((i) => i.doc.doc_id)).toEqual(['A', 'B', 'C'])
    expect(citedCount).toBe(0)
  })
})
