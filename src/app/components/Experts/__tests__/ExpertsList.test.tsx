import { fireEvent, render, screen } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { ExpertsList } from '../ExpertsList'
import type { PersonResult } from '@/lib/experts/types'

const person = (key: string, name: string, office: string, score: number): PersonResult => ({
  key, name, office, offices: { [office]: 2 }, score,
  evidence: { docs: 6, strong: 4, partial: 2, weak: 0, years: [2019, 2025], corpusDocs: 27 },
  topics: [{ label: 'Buses', n: 5, matched: true }, { label: 'Hub', n: 6, matched: false }, { label: 'School Buses', n: 1, matched: true }],
  docIds: ['d1'],
})
const people = [person('xue, lulu', 'Xue, Lulu', 'WRI China', 1), person('sclar, ryan', 'Sclar, Ryan', 'WRI Global', 0.6)]

describe('ExpertsList', () => {
  it('renders rank, name, office, evidence line, and matched topics only', () => {
    render(<ChakraProvider><ExpertsList people={people} mode='evidence' selectedKey={null} peerKeys={new Set()} onHover={jest.fn()} onSelect={jest.fn()} /></ChakraProvider>)
    expect(screen.getByText('Xue, Lulu')).toBeInTheDocument()
    expect(screen.getAllByText('WRI China')[0]).toBeInTheDocument()
    expect(screen.getAllByText(/6 docs · 4 strong · 2 partial · 2019–2025/)[0]).toBeInTheDocument()
    expect(screen.getAllByText(/Buses/)[0]).toBeInTheDocument()
    expect(screen.queryByText(/^Hub/)).not.toBeInTheDocument()
  })

  it('hover and click call back with the key; selected and peer rows are marked', () => {
    const onHover = jest.fn()
    const onSelect = jest.fn()
    render(<ChakraProvider><ExpertsList people={people} mode='evidence' selectedKey='xue, lulu' peerKeys={new Set(['sclar, ryan'])} onHover={onHover} onSelect={onSelect} /></ChakraProvider>)
    const row = screen.getByRole('button', { name: /Sclar, Ryan/ })
    fireEvent.mouseEnter(row)
    expect(onHover).toHaveBeenCalledWith('sclar, ryan')
    fireEvent.mouseLeave(row)
    expect(onHover).toHaveBeenLastCalledWith(null)
    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledWith('sclar, ryan')
    expect(screen.getByRole('button', { name: /Xue, Lulu/ })).toHaveAttribute('aria-pressed', 'true')
    expect(row).toHaveAttribute('data-peer', 'true')
  })

  it('shows topic-only wording when mode is topic_only', () => {
    const p = { ...people[0], evidence: { ...people[0].evidence, docs: 0, strong: 0, partial: 0 }, docIds: ['d1', 'd2'] }
    render(<ChakraProvider><ExpertsList people={[p]} mode='topic_only' selectedKey={null} peerKeys={new Set()} onHover={jest.fn()} onSelect={jest.fn()} /></ChakraProvider>)
    expect(screen.getByText(/2 docs on these topics/)).toBeInTheDocument()
  })
})
