import { fireEvent, render, screen, within } from '@testing-library/react'
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

describe('TopicGraph focus decoration (U5)', () => {
  // Spec §8: "Select person: ink halo (r + 6, ink stroke, surface gap) and an
  // ink name tab with surface text ... Hover is halo-only, so pinned and
  // hovered differ."
  const renderWith = (props: {
    hoverKey?: string | null
    selectedKey?: string | null
  }) =>
    render(
      <TopicGraph
        people={people}
        matched={matched}
        hoverKey={props.hoverKey ?? null}
        selectedKey={props.selectedKey ?? null}
        peerKeys={new Set()}
        onHover={jest.fn()}
        onSelect={jest.fn()}
      />,
    )

  // The name tab lives in the LABEL pass, not inside person-node: labels are
  // painted after every node so a neighbouring circle cannot overdraw them.
  // The halo is a mark, so it stays with the node.
  it('draws the halo but NOT the name tab for a hovered, unpinned person', () => {
    renderWith({ hoverKey: 'k0' })
    const node = screen.getAllByTestId('person-node')[0]
    expect(node).toHaveAttribute('data-state', 'focus')
    expect(within(node).queryByTestId('person-halo')).not.toBeNull()
    expect(screen.queryByTestId('person-name-tab')).toBeNull()
  })

  it('draws both the halo and the name tab for a pinned person', () => {
    renderWith({ selectedKey: 'k0' })
    const node = screen.getAllByTestId('person-node')[0]
    expect(node).toHaveAttribute('data-state', 'focus')
    expect(within(node).queryByTestId('person-halo')).not.toBeNull()
    expect(screen.getAllByTestId('person-name-tab')).toHaveLength(1)
  })

  it('draws neither on a person who is not the focus', () => {
    renderWith({ selectedKey: 'k0' })
    const other = screen.getAllByTestId('person-node')[1]
    expect(within(other).queryByTestId('person-halo')).toBeNull()
    expect(screen.getAllByTestId('person-name-tab')).toHaveLength(1)
  })
})

describe('TopicGraph accessible description (U18)', () => {
  // Spec §8 wants role="img" AND a description. Spec §9 row 1: when the topic
  // facet is degraded the rings are the retrieved docs' own accepted tags, so
  // their size is NOT a query cosine — the accessible name must not claim it is.
  const renderWith = (topicsAreDerived?: boolean) =>
    render(
      <TopicGraph
        people={people}
        matched={matched}
        hoverKey={null}
        selectedKey={null}
        peerKeys={new Set()}
        onHover={jest.fn()}
        onSelect={jest.fn()}
        {...(topicsAreDerived === undefined ? {} : { topicsAreDerived })}
      />,
    )

  it('says the topics match the query on the normal path', () => {
    renderWith(false)
    const svg = screen.getByRole('img')
    expect(svg.getAttribute('aria-label')).toMatch(/match the query/i)
    expect(svg.getAttribute('aria-label')).not.toMatch(/retrieved documents/i)
  })

  it('defaults to the normal wording when the prop is omitted', () => {
    renderWith(undefined)
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(
      /match the query/i,
    )
  })

  it('does not claim a query match when the topics are doc-derived', () => {
    renderWith(true)
    const label = screen.getByRole('img').getAttribute('aria-label') ?? ''
    expect(label).not.toMatch(/match the query/i)
    expect(label).toMatch(/retrieved documents/i)
  })

  it('renders a <desc> that explains the encoding, and says so when derived', () => {
    const { unmount } = renderWith(false)
    const plain = screen.getByRole('img').querySelector('desc')
    expect(plain).not.toBeNull()
    expect(plain!.textContent).toMatch(/person/i)
    expect(plain!.textContent).toMatch(/topic/i)
    unmount()

    renderWith(true)
    const derived = screen.getByRole('img').querySelector('desc')
    expect(derived!.textContent).toMatch(/not query match strengths/i)
  })
})

describe('TopicGraph topic hover is controllable (U14)', () => {
  // Spec §8: the list is the graph's table twin and carries every interaction
  // from the keyboard. Topic hover lived in component-local state, so a topic
  // focused from the chips could highlight the list but never the graph.
  it('enters the topic-hover state from a prop, with no mouse event', () => {
    render(
      <TopicGraph
        people={people}
        matched={matched}
        hoverKey={null}
        selectedKey={null}
        peerKeys={new Set()}
        onHover={jest.fn()}
        onSelect={jest.fn()}
        hoverTopic='Buses'
        onHoverTopic={jest.fn()}
      />,
    )
    expect(screen.getByTestId('graph-hint')).toHaveTextContent(
      'Buses · 10 of the 10 shown people have documents tagged with it',
    )
  })

  it('reports its own topic hover upward so the list can follow', () => {
    const onHoverTopic = jest.fn()
    render(
      <TopicGraph
        people={people}
        matched={matched}
        hoverKey={null}
        selectedKey={null}
        peerKeys={new Set()}
        onHover={jest.fn()}
        onSelect={jest.fn()}
        hoverTopic={null}
        onHoverTopic={onHoverTopic}
      />,
    )
    fireEvent.mouseEnter(screen.getAllByTestId('topic-node')[0])
    expect(onHoverTopic).toHaveBeenCalledWith('Buses')
    fireEvent.mouseLeave(screen.getAllByTestId('topic-node')[0])
    expect(onHoverTopic).toHaveBeenLastCalledWith(null)
  })
})
