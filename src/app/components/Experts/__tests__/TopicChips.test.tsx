import { fireEvent, render, screen } from '@testing-library/react'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { TopicChips } from '../TopicChips'

describe('TopicChips', () => {
  it('renders topics with strength and geographies, and removes a topic', () => {
    const onRemove = jest.fn()
    render(
      <ChakraProvider>
        <TopicChips
          topics={[{ label: 'Buses', cosine: 0.66, df: 19 }]}
          geographies={[{ label: 'China', cosine: 0.41, df: 49 }]}
          onRemove={onRemove}
        />
      </ChakraProvider>,
    )
    expect(screen.getByText('Buses')).toBeInTheDocument()
    expect(screen.getByText('0.66')).toBeInTheDocument()
    expect(screen.getByText('China')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Buses' }))
    expect(onRemove).toHaveBeenCalledWith('Buses')
  })
  it('U3: suppresses the topic strength number when the topics are document-derived', () => {
    render(
      <ChakraProvider>
        <TopicChips
          topics={[{ label: 'Climate Resilience', cosine: 1, df: 19 }]}
          geographies={[{ label: 'China', cosine: 0.41, df: 49 }]}
          derived
          onRemove={jest.fn()}
        />
      </ChakraProvider>,
    )
    expect(screen.getByText('Climate Resilience')).toBeInTheDocument()
    // 1.00 would read as a perfect cosine match; it is a normalized tag count.
    expect(screen.queryByText('1.00')).not.toBeInTheDocument()
    // Geography cosines are unaffected by a degraded topic facet.
    expect(screen.getByText('0.41')).toBeInTheDocument()
  })

  it('renders nothing when there are no matches', () => {
    const { container } = render(
      <TopicChips topics={[]} geographies={[]} onRemove={jest.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('U14: topic hover fires from the mouse AND from the keyboard', () => {
    const onHoverTopic = jest.fn()
    render(
      <ChakraProvider>
        <TopicChips
          topics={[{ label: 'Buses', cosine: 0.66, df: 19 }]}
          geographies={[]}
          onHoverTopic={onHoverTopic}
          onRemove={jest.fn()}
        />
      </ChakraProvider>,
    )
    const remove = screen.getByRole('button', { name: 'Remove Buses' })
    fireEvent.mouseEnter(screen.getByText('Buses').closest('span')!)
    expect(onHoverTopic).toHaveBeenCalledWith('Buses')
    onHoverTopic.mockClear()
    // The chip's only tab stop is its remove control; focusing it must reach
    // the same hover state a mouse does (spec §8).
    fireEvent.focus(remove)
    expect(onHoverTopic).toHaveBeenCalledWith('Buses')
    fireEvent.blur(remove)
    expect(onHoverTopic).toHaveBeenLastCalledWith(null)
  })
})
