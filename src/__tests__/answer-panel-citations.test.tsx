import { render, screen, fireEvent } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { AnswerPanel } from '@/app/components/AnswerMode/AnswerPanel'
import { buildInline } from '@/app/components/AnswerMode/citations'
import type { DocMeta } from '@/lib/llamacloud'

function doc(docId: string, pid: string, rel: number): DocMeta {
  return {
    doc_id: docId,
    ref: docId,
    title: docId,
    kps: [
      {
        kp_relevance: rel,
        snippet: 'x'.repeat(40),
        passage_id: pid,
        page: 1,
        citation_targets: [],
      },
    ],
  }
}
const docs = [doc('A', 'A_1', 0.9), doc('B', 'B_1', 0.8), doc('C', 'C_1', 0.7)]
const sent = [
  { id: 1, doc_id: 'A', chunk_id: 'A_1', page: 1, text: 't' },
  { id: 2, doc_id: 'B', chunk_id: 'B_1', page: 1, text: 't' },
  { id: 3, doc_id: 'C', chunk_id: 'C_1', page: 1, text: 't' },
]

function renderPanel(cites: number[][]) {
  const setPage = jest.fn()
  const inline = buildInline(cites, sent, docs)
  render(
    <ChakraProvider>
      <AnswerPanel
        query='q'
        answer={{ sentences: ['One.', 'Two.'], inline, cites }}
        firstDocHowRelevant=''
        supportingDocs={docs}
        setAnswer={jest.fn()}
        setQuery={jest.fn()}
        ops={null}
        setSupportingCitationsPage={setPage}
        supportingCitationsPage={1}
      />
    </ChakraProvider>,
  )
  return { setPage }
}

describe('AnswerPanel citations', () => {
  it('counts only cited documents', () => {
    renderPanel([[3], [3]])
    expect(
      screen.getByText('Based on 1 Knowledge Product:'),
    ).toBeInTheDocument()
  })

  it('a marker scrolls to the passage the model cited, not the k-th passage', () => {
    // Sentence 2 cites C (lowest relevance). Cited-first ordering puts C at
    // index 0, so the marker must request page 1 — under the old
    // slice-by-position logic it would have requested page 2.
    const { setPage } = renderPanel([[], [3]])
    fireEvent.click(screen.getByTitle('Citation 2.1'))
    expect(setPage).toHaveBeenCalledWith(1)
  })

  it('a sentence with no cites renders no markers', () => {
    renderPanel([[], [1]])
    expect(screen.queryByTitle('Citation 1.1')).not.toBeInTheDocument()
    expect(screen.getByTitle('Citation 2.1')).toBeInTheDocument()
  })

  it('a multi-passage document scrolls to the exact passage sent for synthesis', () => {
    const multiPassageDocs = [
      {
        ...doc('A', 'A_1', 0.1),
        kps: [doc('A', 'A_1', 0.1).kps[0], doc('A', 'A_2', 0.99).kps[0]],
      },
      doc('B', 'B_1', 0.8),
    ]
    const passagesSent = [
      { id: 1, doc_id: 'A', chunk_id: 'A_1', page: 1, text: 't' },
    ]
    const setPage = jest.fn()
    const inline = buildInline([[1]], passagesSent, multiPassageDocs)

    render(
      <ChakraProvider>
        <AnswerPanel
          query='q'
          answer={{ sentences: ['One.'], inline, cites: [[1]] }}
          firstDocHowRelevant=''
          supportingDocs={multiPassageDocs}
          setAnswer={jest.fn()}
          setQuery={jest.fn()}
          ops={null}
          setSupportingCitationsPage={setPage}
          supportingCitationsPage={1}
        />
      </ChakraProvider>,
    )

    fireEvent.click(screen.getByTitle('Citation 1.1'))
    expect(inline[0][0].passage_id).toBe('A:A_1')
    expect(setPage).toHaveBeenCalledWith(1)
  })
})
