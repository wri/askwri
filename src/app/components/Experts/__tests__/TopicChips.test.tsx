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
  it('renders nothing when there are no matches', () => {
    const { container } = render(
      <TopicChips topics={[]} geographies={[]} onRemove={jest.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
