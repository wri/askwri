import { fireEvent, render, screen } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { ExpertEvidence } from '../ExpertEvidence'
import type { DocResult, PersonResult } from '@/lib/experts/types'

const person: PersonResult = {
  key: 'xue, lulu', name: 'Xue, Lulu', office: 'WRI China', offices: { 'WRI China': 2, 'WRI Global': 1 }, score: 1,
  evidence: { docs: 2, strong: 1, partial: 1, weak: 0, years: [2021, 2025], corpusDocs: 27 },
  topics: [{ label: 'Buses', n: 2, matched: true }, { label: 'Hub', n: 3, matched: false }], docIds: ['d1', 'd2'],
}
const docs: Record<string, DocResult> = {
  d1: { docId: 'd1', title: 'Older partial', year: 2021, type: 'Report', office: 'WRI China', tier: 'partial', url: 'https://x/1', authors: [{ key: 'chen, ke', name: 'Chen, Ke', org: false }, { key: 'xue, lulu', name: 'Xue, Lulu', org: false }], topics: ['Buses'], geographies: [], translations: [] },
  d2: { docId: 'd2', title: 'Newer strong', year: 2025, type: 'Working Paper', office: 'WRI China', tier: 'strong', url: null, authors: [{ key: 'xue, lulu', name: 'Xue, Lulu', org: false }], topics: ['Buses', 'Hub'], geographies: ['China'], translations: ['d2-es'] },
}

describe('ExpertEvidence', () => {
  it('shows offices, concentration, docs by tier then year, author position, and translations', () => {
    render(<ChakraProvider><ExpertEvidence person={person} docs={docs} peers={[{ key: 'chen, ke', name: 'Chen, Ke', shared: 5, topics: ['Buses'] }]} mode='evidence' matched={[{ label: 'Buses', cosine: 0.6, df: 19 }]} onSelectPeer={jest.fn()} onClose={jest.fn()} /></ChakraProvider>)
    expect(screen.getByRole('heading', { name: 'Xue, Lulu' })).toBeInTheDocument()
    expect(screen.getByText(/WRI China \(2\), WRI Global \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/2 of 27 documents match/)).toBeInTheDocument()
    const titles = screen.getAllByTestId('evidence-doc-title').map((n) => n.textContent)
    expect(titles).toEqual(['Newer strong', 'Older partial'])
    expect(screen.getByText(/author 2 of 2/)).toBeInTheDocument()
    expect(screen.getByText(/also in 1 translation/)).toBeInTheDocument()
  })

  it('peer click and close call back', () => {
    const onSelectPeer = jest.fn()
    const onClose = jest.fn()
    render(<ChakraProvider><ExpertEvidence person={person} docs={docs} peers={[{ key: 'chen, ke', name: 'Chen, Ke', shared: 5, topics: ['Buses'] }]} mode='evidence' matched={[]} onSelectPeer={onSelectPeer} onClose={onClose} /></ChakraProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Chen, Ke' }))
    expect(onSelectPeer).toHaveBeenCalledWith('chen, ke')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })
})
