import fs from 'fs'
import path from 'path'
import { fireEvent, render, screen } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { ExpertsList } from '../ExpertsList'
import type { PersonResult } from '@/lib/experts/types'

const person = (
  key: string,
  name: string,
  office: string,
  score: number,
): PersonResult => ({
  key,
  name,
  office,
  offices: { [office]: 2 },
  score,
  evidence: {
    docs: 6,
    strong: 4,
    partial: 2,
    weak: 0,
    years: [2019, 2025],
    corpusDocs: 27,
  },
  topics: [
    { label: 'Buses', n: 5, matched: true },
    { label: 'Hub', n: 6, matched: false },
    { label: 'School Buses', n: 1, matched: true },
  ],
  docIds: ['d1'],
})
const people = [
  person('xue, lulu', 'Xue, Lulu', 'WRI China', 1),
  person('sclar, ryan', 'Sclar, Ryan', 'WRI Global', 0.6),
]

describe('ExpertsList', () => {
  it('renders rank, name, office, evidence line, and matched topics only', () => {
    render(
      <ChakraProvider>
        <ExpertsList
          people={people}
          mode='evidence'
          selectedKey={null}
          peerKeys={new Set()}
          onHover={jest.fn()}
          onSelect={jest.fn()}
        />
      </ChakraProvider>,
    )
    expect(screen.getByText('Xue, Lulu')).toBeInTheDocument()
    expect(screen.getAllByText('WRI China')[0]).toBeInTheDocument()
    expect(
      screen.getAllByText(/6 docs · 4 strong · 2 partial · 2019–2025/)[0],
    ).toBeInTheDocument()
    expect(screen.getAllByText(/Buses/)[0]).toBeInTheDocument()
    expect(screen.queryByText(/^Hub/)).not.toBeInTheDocument()
  })

  it('hover and click call back with the key; selected and peer rows are marked', () => {
    const onHover = jest.fn()
    const onSelect = jest.fn()
    render(
      <ChakraProvider>
        <ExpertsList
          people={people}
          mode='evidence'
          selectedKey='xue, lulu'
          peerKeys={new Set(['sclar, ryan'])}
          onHover={onHover}
          onSelect={onSelect}
        />
      </ChakraProvider>,
    )
    const row = screen.getByRole('button', { name: /Sclar, Ryan/ })
    fireEvent.mouseEnter(row)
    expect(onHover).toHaveBeenCalledWith('sclar, ryan')
    fireEvent.mouseLeave(row)
    expect(onHover).toHaveBeenLastCalledWith(null)
    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledWith('sclar, ryan')
    expect(screen.getByRole('button', { name: /Xue, Lulu/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(row).toHaveAttribute('data-peer', 'true')
  })

  it('shows topic-only wording when mode is topic_only', () => {
    const p = {
      ...people[0],
      evidence: { ...people[0].evidence, docs: 0, strong: 0, partial: 0 },
      docIds: ['d1', 'd2'],
    }
    render(
      <ChakraProvider>
        <ExpertsList
          people={[p]}
          mode='topic_only'
          selectedKey={null}
          peerKeys={new Set()}
          onHover={jest.fn()}
          onSelect={jest.fn()}
        />
      </ChakraProvider>,
    )
    expect(screen.getByText(/2 docs on these topics/)).toBeInTheDocument()
  })

  it('R6-UI: evidence mode, all tiers 0 — counts docIds and says "on these topics"', () => {
    // rank.ts now counts RETRIEVED works in evidence.docs, so a tag-only
    // candidate reports 0 there while docIds still carries their topic-matched
    // works. Rendering evidence.docs would print "0 docs".
    const p: PersonResult = {
      ...people[0],
      evidence: {
        docs: 0,
        strong: 0,
        partial: 0,
        weak: 0,
        years: [2020, 2025],
        corpusDocs: 27,
      },
      docIds: ['d1', 'd2', 'd3'],
    }
    render(
      <ChakraProvider>
        <ExpertsList
          people={[p]}
          mode='evidence'
          selectedKey={null}
          peerKeys={new Set()}
          onHover={jest.fn()}
          onSelect={jest.fn()}
        />
      </ChakraProvider>,
    )
    expect(
      screen.getByText('3 docs on these topics · 2020–2025'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/0 doc/)).not.toBeInTheDocument()
  })

  it('R6-UI: evidence mode, all tiers 0, no years renders just the topic docs', () => {
    const p: PersonResult = {
      ...people[0],
      evidence: {
        docs: 0,
        strong: 0,
        partial: 0,
        weak: 0,
        years: null,
        corpusDocs: 27,
      },
      docIds: ['d1'],
    }
    render(
      <ChakraProvider>
        <ExpertsList
          people={[p]}
          mode='evidence'
          selectedKey={null}
          peerKeys={new Set()}
          onHover={jest.fn()}
          onSelect={jest.fn()}
        />
      </ChakraProvider>,
    )
    expect(screen.getByText('1 doc on these topics')).toBeInTheDocument()
  })

  it('U13: rows advertise the evidence panel they control', () => {
    render(
      <ChakraProvider>
        <ExpertsList
          people={people}
          mode='evidence'
          selectedKey='xue, lulu'
          peerKeys={new Set()}
          onHover={jest.fn()}
          onSelect={jest.fn()}
        />
      </ChakraProvider>,
    )
    const selected = screen.getByRole('button', { name: /Xue, Lulu/ })
    expect(selected).toHaveAttribute('aria-controls', 'experts-evidence-panel')
    expect(selected).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /Sclar, Ryan/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('U14: a hovered topic marks the rows that carry it', () => {
    render(
      <ChakraProvider>
        <ExpertsList
          people={[
            people[0],
            {
              ...people[1],
              topics: [{ label: 'Hub', n: 2, matched: false }],
            },
          ]}
          mode='evidence'
          selectedKey={null}
          peerKeys={new Set()}
          hoverTopic='Buses'
          onHover={jest.fn()}
          onSelect={jest.fn()}
        />
      </ChakraProvider>,
    )
    expect(screen.getByRole('button', { name: /Xue, Lulu/ })).toHaveAttribute(
      'data-topic-match',
      'true',
    )
    expect(screen.getByRole('button', { name: /Sclar, Ryan/ })).toHaveAttribute(
      'data-topic-match',
      'false',
    )
  })

  it('C-1: at rest NO row carries data-topic-match, so nothing is faded', () => {
    // The CSS fades [data-topic-match='false'] to 45% opacity. Emitting 'false'
    // whenever hoverTopic is null put EVERY unselected row in the ranked list —
    // the page's primary surface — permanently at 45%. next/jest stubs the CSS
    // import, so asserting the attribute is the only way this is catchable
    // short of driving a real browser.
    render(
      <ChakraProvider>
        <ExpertsList
          people={people}
          mode='evidence'
          selectedKey={null}
          peerKeys={new Set()}
          hoverTopic={null}
          onHover={jest.fn()}
          onSelect={jest.fn()}
        />
      </ChakraProvider>,
    )
    for (const row of screen.getAllByRole('button'))
      expect(row).not.toHaveAttribute('data-topic-match')
  })

  it('U16: gold is reserved for relevance — hover and selection are not gold', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'Experts.css'),
      'utf8',
    )
    const rule = (selector: string) =>
      css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)))
    expect(rule('.experts-row:hover')).not.toMatch(/240,\s*171,\s*0/)
    expect(rule(".experts-row[aria-pressed='true']")).not.toMatch(
      /240,\s*171,\s*0/,
    )
    // The peer tint stays gold: spec §8 golds peers.
    expect(rule(".experts-row[data-peer='true']")).toMatch(/240,\s*171,\s*0/)
    // The selected row's ink left rule stays.
    expect(rule(".experts-row[aria-pressed='true']")).toMatch(/#1b1a17/)
  })

  it('R6-UI: a person with tier counts keeps the evidence phrasing', () => {
    const p: PersonResult = {
      ...people[0],
      evidence: {
        docs: 1,
        strong: 0,
        partial: 0,
        weak: 2,
        years: [2022, 2022],
        corpusDocs: 27,
      },
      docIds: ['d1', 'd2', 'd3'],
    }
    render(
      <ChakraProvider>
        <ExpertsList
          people={[p]}
          mode='evidence'
          selectedKey={null}
          peerKeys={new Set()}
          onHover={jest.fn()}
          onSelect={jest.fn()}
        />
      </ChakraProvider>,
    )
    expect(screen.getByText('1 doc · 2 weak · 2022')).toBeInTheDocument()
  })
})
