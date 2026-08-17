/** @jest-environment jsdom */
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { TopicTaxonomyManager } from '@/app/admin/topics/components/TopicTaxonomyManager'

// jsdom lacks IntersectionObserver — stub it so progressive-render code
// doesn't crash. Tests can capture the callback to simulate intersection.
let ioCallback: ((entries: { isIntersecting: boolean }[]) => void) | null = null
class MockIO {
  observe = jest.fn((_node: any) => {})
  unobserve = jest.fn()
  disconnect = jest.fn()
  takeRecords = jest.fn(() => [])
  root = null
  rootMargin = ''
  thresholds = []
  constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
    ioCallback = cb
  }
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
    needsReembed: false,
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
    needsReembed: false,
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
    needsReembed: false,
  },
]

function mockFetch(tags: any[]) {
  global.fetch = jest.fn((url: string) => {
    if (url === '/api/admin/topics') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, tags }),
      }) as any
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    }) as any
  })
}

describe('TopicTaxonomyManager (jsdom)', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    ioCallback = null
  })

  it('renders heading and topic rows after load', async () => {
    mockFetch(mockTags)
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
    mockFetch(mockTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
    })
    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Global Warming' } })
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

  it('hides children when a tree node is collapsed', async () => {
    mockFetch(mockTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    // Wait for load — both Coal and Coal Combustion should be visible (root expanded)
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
      expect(screen.getByText('Coal Combustion')).toBeTruthy()
    })

    // Click the collapse chevron on Coal (the root parent)
    const chevron = screen.getByText('▾')
    fireEvent.click(chevron)

    // Coal Combustion should now be hidden (collapsed)
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
      expect(screen.queryByText('Coal Combustion')).toBeNull()
    })

    // Click again to re-expand
    const chevron2 = screen.getByText('▸')
    fireEvent.click(chevron2)
    await waitFor(() => {
      expect(screen.getByText('Coal Combustion')).toBeTruthy()
    })
  })

  it('shows needs-re-embed stat chip when tags have needsReembed=true', async () => {
    const tagsWithReembed = [
      { ...mockTags[0], needsReembed: true },
      { ...mockTags[1], needsReembed: true },
      { ...mockTags[2], needsReembed: false },
    ]
    mockFetch(tagsWithReembed)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    // Wait for data to load (Coal is a data-dependent element)
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
    })
    // The stat chip should show "2 need re-embed"
    expect(screen.getByText(/need re-embed/i)).toBeTruthy()
  })

  it('does not show needs-re-embed stat when count is 0', async () => {
    mockFetch(mockTags) // all needsReembed: false
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('Coal')).toBeTruthy()
    })
    expect(screen.queryByText(/need re-embed/i)).toBeNull()
  })

  it('progressive render loads more rows when sentinel intersects', async () => {
    // Create >200 tags with zero-padded names so alphabetical sort = numerical
    const manyTags = Array.from({ length: 250 }, (_, i) => ({
      id: `tag-${i}`,
      facet: 'topic',
      valueId: `Topic ${String(i).padStart(3, '0')}`,
      taxonomyVersion: 'v1',
      parentTagId: null,
      description: null,
      aliases: [],
      acceptedCount: 0,
      suggestedCount: 0,
      needsReembed: false,
    }))

    mockFetch(manyTags)
    render(
      <ChakraProvider>
        <TopicTaxonomyManager />
      </ChakraProvider>,
    )

    // Wait for load — first 200 should be visible (Topic 000 through Topic 199)
    await waitFor(() => {
      expect(screen.getByText('Topic 000')).toBeTruthy()
      expect(screen.getByText('Topic 199')).toBeTruthy()
    })

    // Topic 200 should NOT be visible yet (only 200 shown, zero-padded so alpha = numeric)
    expect(screen.queryByText('Topic 200')).toBeNull()

    // Fire the IO callback to simulate sentinel intersection
    expect(ioCallback).toBeTruthy()
    ioCallback!([{ isIntersecting: true }])

    // Now Topic 200 should be visible (200 more loaded)
    await waitFor(() => {
      expect(screen.getByText('Topic 200')).toBeTruthy()
    })
  })
})
