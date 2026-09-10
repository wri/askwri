import { fireEvent, render, screen } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { ExpertEvidence } from '../ExpertEvidence'
import type { DocResult, PersonResult } from '@/lib/experts/types'

const person: PersonResult = {
  key: 'xue, lulu',
  name: 'Xue, Lulu',
  office: 'WRI China',
  offices: { 'WRI China': 2, 'WRI Global': 1 },
  score: 1,
  evidence: {
    docs: 2,
    strong: 1,
    partial: 1,
    weak: 0,
    years: [2021, 2025],
    corpusDocs: 27,
  },
  topics: [
    { label: 'Buses', n: 2, matched: true },
    { label: 'Hub', n: 3, matched: false },
  ],
  docIds: ['d1', 'd2'],
}
const docs: Record<string, DocResult> = {
  d1: {
    docId: 'd1',
    title: 'Older partial',
    year: 2021,
    type: 'Report',
    office: 'WRI China',
    tier: 'partial',
    url: 'https://x/1',
    authors: [
      { key: 'chen, ke', name: 'Chen, Ke', org: false },
      { key: 'xue, lulu', name: 'Xue, Lulu', org: false },
    ],
    topics: ['Buses'],
    geographies: [],
    translations: [],
  },
  d2: {
    docId: 'd2',
    title: 'Newer strong',
    year: 2025,
    type: 'Working Paper',
    office: 'WRI China',
    tier: 'strong',
    url: null,
    authors: [{ key: 'xue, lulu', name: 'Xue, Lulu', org: false }],
    topics: ['Buses', 'Hub'],
    geographies: ['China'],
    translations: ['d2-es'],
  },
}

describe('ExpertEvidence', () => {
  it('shows offices, concentration, docs by tier then year, author position, and translations', () => {
    render(
      <ChakraProvider>
        <ExpertEvidence
          person={person}
          docs={docs}
          peers={[
            { key: 'chen, ke', name: 'Chen, Ke', shared: 5, topics: ['Buses'] },
          ]}
          mode='evidence'
          matched={[{ label: 'Buses', cosine: 0.6, df: 19 }]}
          onSelectPeer={jest.fn()}
          onClose={jest.fn()}
        />
      </ChakraProvider>,
    )
    expect(
      screen.getByRole('heading', { name: 'Xue, Lulu' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/WRI China \(2\), WRI Global \(1\)/),
    ).toBeInTheDocument()
    expect(screen.getByText(/2 of 27 documents match/)).toBeInTheDocument()
    const titles = screen
      .getAllByTestId('evidence-doc-title')
      .map((n) => n.textContent)
    expect(titles).toEqual(['Newer strong', 'Older partial'])
    expect(screen.getByText(/author 2 of 2/)).toBeInTheDocument()
    expect(screen.getByText(/also in 1 translation/)).toBeInTheDocument()
  })

  it('peer click and close call back', () => {
    const onSelectPeer = jest.fn()
    const onClose = jest.fn()
    render(
      <ChakraProvider>
        <ExpertEvidence
          person={person}
          docs={docs}
          peers={[
            { key: 'chen, ke', name: 'Chen, Ke', shared: 5, topics: ['Buses'] },
          ]}
          mode='evidence'
          matched={[]}
          onSelectPeer={onSelectPeer}
          onClose={onClose}
        />
      </ChakraProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Chen, Ke' }))
    expect(onSelectPeer).toHaveBeenCalledWith('chen, ke')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('U11: a credit that is not among the document authors never says "author 0 of n"', () => {
    // Reachable via a translation row (spec §4.1): the work is credited to the
    // person but this row's author list is the translation's own.
    const translated: Record<string, DocResult> = {
      d1: {
        ...docs.d1,
        authors: [{ key: 'chen, ke', name: 'Chen, Ke', org: false }],
      },
    }
    render(
      <ChakraProvider>
        <ExpertEvidence
          person={{ ...person, docIds: ['d1'] }}
          docs={translated}
          peers={[]}
          mode='evidence'
          matched={[]}
          onSelectPeer={jest.fn()}
          onClose={jest.fn()}
        />
      </ChakraProvider>,
    )
    expect(screen.queryByText(/author 0 of/)).not.toBeInTheDocument()
    expect(screen.getByText(/1 author/)).toBeInTheDocument()
  })

  it('U12: a null year range leaves no trailing separator in the header', () => {
    render(
      <ChakraProvider>
        <ExpertEvidence
          person={{ ...person, evidence: { ...person.evidence, years: null } }}
          docs={docs}
          peers={[]}
          mode='evidence'
          matched={[]}
          onSelectPeer={jest.fn()}
          onClose={jest.fn()}
        />
      </ChakraProvider>,
    )
    const header = screen.getByText(/documents match/)
    expect(header.textContent).toBe(
      'WRI China (2), WRI Global (1) · 2 of 27 documents match',
    )
  })

  it('U13: opening moves focus to the panel heading and Close restores it', () => {
    const onClose = jest.fn()
    const originRow = document.createElement('button')
    originRow.id = 'origin-row'
    document.body.appendChild(originRow)
    originRow.focus()
    render(
      <ChakraProvider>
        <ExpertEvidence
          person={person}
          docs={docs}
          peers={[]}
          mode='evidence'
          matched={[]}
          returnFocusTo='origin-row'
          onSelectPeer={jest.fn()}
          onClose={onClose}
        />
      </ChakraProvider>,
    )
    const heading = screen.getByRole('heading', { name: 'Xue, Lulu' })
    expect(heading).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
    expect(document.getElementById('origin-row')).toHaveFocus()
    originRow.remove()
  })

  it('U13: the panel is a labelled region with a stable id for aria-controls', () => {
    render(
      <ChakraProvider>
        <ExpertEvidence
          person={person}
          docs={docs}
          peers={[]}
          mode='evidence'
          matched={[]}
          onSelectPeer={jest.fn()}
          onClose={jest.fn()}
        />
      </ChakraProvider>,
    )
    const panel = screen.getByRole('region', { name: 'Xue, Lulu' })
    expect(panel).toHaveAttribute('id', 'experts-evidence-panel')
    // aria-live on a region that mounts with its content never announces.
    expect(panel).not.toHaveAttribute('aria-live')
  })
})

describe('ExpertEvidence for a tag-only candidate in evidence mode (I-2)', () => {
  // R6 made evidence.docs a RETRIEVAL count, so a candidate who reached the
  // list purely through topic space reports 0 there while docIds still holds
  // their topic-matched works. ExpertsList was rephrased for that; the panel
  // still branched on `mode`, so the row said "3 docs on these topics" and the
  // panel it opened said "0 of 27 documents match · Evidence · 0 strong…".
  const tagOnly: PersonResult = {
    ...person,
    evidence: { ...person.evidence, docs: 0, strong: 0, partial: 1, weak: 0 },
  }
  const tagOnlyDocs: Record<string, DocResult> = {
    d1: { ...docs.d1, tier: null },
    d2: { ...docs.d2, tier: null },
  }
  const renderPanel = (p: PersonResult) =>
    render(
      <ChakraProvider>
        <ExpertEvidence
          person={p}
          docs={tagOnlyDocs}
          peers={[]}
          matched={[{ label: 'Buses', cosine: 0.6, df: 19 }]}
          mode='evidence'
          onSelectPeer={jest.fn()}
          onClose={jest.fn()}
        />
      </ChakraProvider>,
    )

  it('does not claim 0 documents match when its own docs are on these topics', () => {
    renderPanel({ ...tagOnly, evidence: { ...tagOnly.evidence, partial: 0 } })
    expect(
      screen.queryByText(/0 of 27 documents match/),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/2 of 27 documents are on these topics/),
    ).toBeInTheDocument()
  })

  it('does not head the list "0 strong, 0 partial, 0 weak"', () => {
    renderPanel({ ...tagOnly, evidence: { ...tagOnly.evidence, partial: 0 } })
    expect(
      screen.queryByText(/0 strong, 0 partial, 0 weak/),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Documents on these topics')).toBeInTheDocument()
  })

  it('still shows the retrieval framing when there IS tier evidence', () => {
    renderPanel(tagOnly)
    expect(screen.getByText(/0 of 27 documents match/)).toBeInTheDocument()
  })
})
