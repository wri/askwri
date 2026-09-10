import { fireEvent, render, screen } from '@testing-library/react'
import { TopicGraph } from '../TopicGraph'
import type { MatchedTag, PersonResult } from '@/lib/experts/types'

const p = (
  key: string,
  name: string,
  score: number,
  office: string,
  topics: Record<string, number>,
): PersonResult => ({
  key,
  name,
  office,
  offices: {},
  score,
  evidence: {
    docs: 1,
    strong: 1,
    partial: 0,
    weak: 0,
    years: null,
    corpusDocs: 1,
  },
  topics: Object.entries(topics).map(([label, n]) => ({
    label,
    n,
    matched: true,
  })),
  docIds: [],
})
const people = Array.from({ length: 10 }, (_, i) =>
  p(`k${i}`, `Person ${i}`, 1 - i * 0.08, 'WRI Global', { Buses: 1 }),
)
const matched: MatchedTag[] = [{ label: 'Buses', cosine: 0.66, df: 19 }]

describe('TopicGraph', () => {
  it('renders every person and topic node; labels people ranked > 8 as quiet', () => {
    render(
      <TopicGraph
        people={people}
        matched={matched}
        totalWorks={201}
        hoverKey={null}
        selectedKey={null}
        peerKeys={new Set()}
        onHover={jest.fn()}
        onSelect={jest.fn()}
      />,
    )
    expect(screen.getByRole('img')).toBeInTheDocument()
    expect(screen.getAllByTestId('person-node')).toHaveLength(10)
    expect(screen.getAllByTestId('topic-node')).toHaveLength(1)
    const quiet = screen
      .getAllByTestId('person-label')
      .filter((n) => n.getAttribute('data-quiet') === 'true')
    expect(quiet).toHaveLength(2)
  })

  it('marks focus, peers, dim; hover and click call back', () => {
    const onHover = jest.fn()
    const onSelect = jest.fn()
    render(
      <TopicGraph
        people={people}
        matched={matched}
        totalWorks={201}
        hoverKey={null}
        selectedKey='k0'
        peerKeys={new Set(['k1'])}
        onHover={onHover}
        onSelect={onSelect}
      />,
    )
    const nodes = screen.getAllByTestId('person-node')
    expect(nodes[0]).toHaveAttribute('data-state', 'focus')
    expect(nodes[1]).toHaveAttribute('data-state', 'peer')
    expect(nodes[2]).toHaveAttribute('data-state', 'dim')
    fireEvent.mouseEnter(nodes[2])
    expect(onHover).toHaveBeenCalledWith('k2')
    fireEvent.click(nodes[2])
    expect(onSelect).toHaveBeenCalledWith('k2')
    expect(screen.getByTestId('graph-hint').textContent).toMatch(/Person 0/)
  })
})
