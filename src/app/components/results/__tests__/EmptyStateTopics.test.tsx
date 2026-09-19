import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { EmptyStateTopics } from '../EmptyStateTopics'

describe('EmptyStateTopics', () => {
  it('shows the query and clickable nearby topics', () => {
    const onPick = jest.fn()
    render(
      <ChakraProvider>
        <EmptyStateTopics
          query='quantum transit'
          topics={['freight', 'air quality']}
          onPickTopic={onPick}
        />
      </ChakraProvider>,
    )
    expect(screen.getByText(/No strong matches for/)).toBeInTheDocument()
    expect(screen.getByText(/quantum transit/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('freight'))
    expect(onPick).toHaveBeenCalledWith('freight')
  })

  it('renders a plain empty message when there are no topics', () => {
    render(
      <EmptyStateTopics
        query='quantum transit'
        topics={[]}
        onPickTopic={jest.fn()}
      />,
    )
    expect(screen.getByText(/No strong matches for/)).toBeInTheDocument()
    expect(screen.queryByText(/Nearby topics/)).not.toBeInTheDocument()
  })
})
