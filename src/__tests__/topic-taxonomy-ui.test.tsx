/** @jest-environment jsdom */
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { TopicTaxonomyManager } from '@/app/admin/topics/components/TopicTaxonomyManager'

// jsdom lacks IntersectionObserver — stub it so progressive-render code
// doesn't crash. The sentinel simply never fires in tests.
class MockIO {
  observe = jest.fn()
  unobserve = jest.fn()
  disconnect = jest.fn()
  takeRecords = jest.fn(() => [])
  root = null
  rootMargin = ''
  thresholds = []
}
;(globalThis as any).IntersectionObserver = MockIO

const mockTags = [
  {
    id: 't1',
    facet: 'topic',
    valueId: 'Coal',
    taxonomyVersion: 'v1',
    parentTagId: null,
    description: 'Fossil fuel',
    aliases: ['Coal Industry'],
    acceptedCount: 12,
    suggestedCount: 3,
  },
  {
    id: 't2',
    facet: 'topic',
    valueId: 'Coal Combustion',
    taxonomyVersion: 'v1',
    parentTagId: 't1',
    description: 'Power generation',
    aliases: [],
    acceptedCount: 3,
    suggestedCount: 0,
  },
  {
    id: 't3',
    facet: 'topic',
    valueId: 'Climate',
    taxonomyVersion: 'v1',
    parentTagId: null,
    description: 'Long-term shifts in temperatures',
    aliases: ['Climate Change', 'Global Warming'],
    acceptedCount: 45,
    suggestedCount: 5,
  },
]

describe('TopicTaxonomyManager (jsdom)', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('renders heading and topic rows after load', async () => {
    global.fetch = jest.fn((url: string) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      }) as any
    })

    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Topic taxonomy')).toBeTruthy()
      expect(screen.getByText('Coal')).toBeTruthy()
    })
    expect(screen.getByText('Climate')).toBeTruthy()
  })

  it('filters rows by search query (label + aliases + description)', async () => {
    global.fetch = jest.fn((url: string) => {
      if (url === '/api/admin/topics') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, tags: mockTags }),
        }) as any
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as any
    })

    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )

    // Wait for load
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
    })

    // Type a search query that matches Climate's alias "Global Warming"
    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Global Warming' } })

    // Climate should still be visible; Coal should be hidden
    await waitFor(() => {
      expect(screen.getByText('Climate')).toBeTruthy()
      expect(screen.queryByText('Coal')).toBeNull()
    })
  })

  it('shows error message on fetch failure', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ error: 'something went wrong' }),
      }) as any,
    )

    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeTruthy()
    })
  })
})
