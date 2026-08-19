import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import ResultsPage from '@/app/results/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { chatCiteLlamaIndex } from '@/lib/llamaindex-client'

// Mutable search param so tests can drive ?q= and rerender.
let currentQ: string | null = null
const routerPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerPush,
    replace: jest.fn(),
    prefetch: jest.fn(),
    refresh: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
  }),
  usePathname: () => '/results',
  useSearchParams: () => ({
    get: (k: string) => (k === 'q' ? currentQ : null),
  }),
}))

jest.mock('@/lib/llamaindex-client', () => ({
  chatCiteLlamaIndex: jest.fn(),
}))

jest.mock('@/lib/catalog-cache', () => ({
  getCatalog: () => Promise.resolve({ catalog: [], index: null }),
}))

// Stub CitePanel: exposes the props the page threads through, and a remove
// button per hard facet so tests can drive onRemoveFacet.
jest.mock('@/app/results/CitePanel', () => ({
  __esModule: true,
  default: (props: any) => (
    <div
      data-testid='cite-panel'
      data-query={props.query}
      data-docs={props.docs.length}
    >
      {(props.queryUnderstanding?.facets ?? [])
        .filter((f: any) => f.action === 'hard')
        .map((f: any) => (
          <button
            key={`${f.facet}:${f.value}`}
            data-testid={`remove-${f.facet}`}
            onClick={() =>
              props.onRemoveFacet({ facet: f.facet, value: f.value })
            }
          >
            remove {f.facet}
          </button>
        ))}
    </div>
  ),
}))

const mockCite = chatCiteLlamaIndex as jest.Mock

const doc = (id: string) => ({ doc_id: id, kps: [] })

const citeResponse = (docs: any[], understanding: any = null): any => ({
  docs,
  usage: {},
  debug: {},
  queryUnderstanding: understanding,
})

const renderPage = (q: string) => {
  currentQ = q
  return render(
    <ChakraProvider>
      <ResultsPage />
    </ChakraProvider>,
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  currentQ = null
  global.fetch = jest.fn((url: any) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve(
          String(url).includes('batch-relates')
            ? { results: [] }
            : { ok: false },
        ),
    }),
  ) as any
})

describe('results page — facet chips', () => {
  it('re-queries with the remaining facets when a chip is removed', async () => {
    const understanding = {
      facets: [
        { facet: 'year_min', value: '2020', action: 'hard', source: 'parser' },
      ],
      suggestions: [],
    }
    mockCite
      .mockResolvedValueOnce(
        citeResponse([doc('a'), doc('b'), doc('c')], understanding),
      )
      .mockResolvedValueOnce(
        citeResponse([doc('a'), doc('b'), doc('c'), doc('d')], {
          facets: [],
          suggestions: [],
        }),
      )

    renderPage('hydrogen since 2020')
    await waitFor(() =>
      expect(screen.getByTestId('cite-panel')).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByTestId('remove-year_min'))

    // The removal must trigger a fresh request carrying the post-removal
    // facet list (explicit empty = auto-detection off), never a cache hit
    // on the auto-mode entry and never the stale pre-removal facets.
    await waitFor(() => expect(mockCite).toHaveBeenCalledTimes(2))
    expect(mockCite).toHaveBeenNthCalledWith(2, 'hydrogen since 2020', {
      facets: [],
    })
    await waitFor(() =>
      expect(screen.getByTestId('cite-panel')).toHaveAttribute(
        'data-docs',
        '4',
      ),
    )
  })

  it('renders removable chips on the empty state when a facet filtered everything out', async () => {
    const understanding = {
      facets: [
        { facet: 'language', value: 'es', action: 'hard', source: 'parser' },
      ],
      suggestions: [],
    }
    mockCite
      .mockResolvedValueOnce(citeResponse([], understanding))
      .mockResolvedValueOnce(
        citeResponse([doc('a')], { facets: [], suggestions: [] }),
      )

    renderPage('street safety in spanish')
    await waitFor(() =>
      expect(screen.getByText(/No strong matches/)).toBeInTheDocument(),
    )

    // The facet that produced zero results must still be removable.
    fireEvent.click(
      screen.getByRole('button', { name: /Remove Spanish filter/i }),
    )
    await waitFor(() => expect(mockCite).toHaveBeenCalledTimes(2))
    expect(mockCite).toHaveBeenNthCalledWith(2, 'street safety in spanish', {
      facets: [],
    })
  })
})

describe('results page — did-you-mean auto-switch', () => {
  it('switches once, updates the displayed query, and never chains switches', async () => {
    mockCite
      .mockResolvedValueOnce(
        citeResponse([doc('a')], {
          facets: [],
          suggestions: [{ type: 'spelling', text: 'hydrogen buses' }],
        }),
      )
      .mockResolvedValueOnce(
        citeResponse([doc('a'), doc('b')], {
          facets: [],
          // A further suggestion with <3 docs: a second hop would loop.
          suggestions: [{ type: 'spelling', text: 'hydrogen busses' }],
        }),
      )

    renderPage('hydrogin buses')

    await waitFor(() =>
      expect(screen.getByTestId('cite-panel')).toBeInTheDocument(),
    )
    expect(mockCite).toHaveBeenCalledTimes(2)
    expect(mockCite).toHaveBeenNthCalledWith(2, 'hydrogen buses', {})

    // The corrected query is what the page now shows; the banner offers the
    // ORIGINAL text back.
    expect(screen.getByTestId('cite-panel')).toHaveAttribute(
      'data-query',
      'hydrogen buses',
    )
    expect(
      screen.getByRole('button', {
        name: /search for “hydrogin buses” as typed/,
      }),
    ).toBeInTheDocument()

    // Downstream calls (alignment) must use the corrected query, not the typo.
    await waitFor(() => {
      const alignmentCall = (global.fetch as jest.Mock).mock.calls.find((c) =>
        String(c[0]).includes('/api/alignment'),
      )
      expect(alignmentCall).toBeTruthy()
      expect(JSON.parse(alignmentCall![1].body).query).toBe('hydrogen buses')
    })
  })

  it('"as typed" re-queries the original with expansion suppressed', async () => {
    mockCite
      .mockResolvedValueOnce(
        citeResponse([doc('a')], {
          facets: [],
          suggestions: [{ type: 'spelling', text: 'hydrogen buses' }],
        }),
      )
      .mockResolvedValueOnce(
        citeResponse([doc('a'), doc('b')], { facets: [], suggestions: [] }),
      )
      .mockResolvedValueOnce(citeResponse([doc('a')], null))

    renderPage('hydrogin buses')
    await waitFor(() =>
      expect(screen.getByTestId('cite-panel')).toBeInTheDocument(),
    )
    await waitFor(() => expect(mockCite).toHaveBeenCalledTimes(2))

    fireEvent.click(
      screen.getByRole('button', {
        name: /search for “hydrogin buses” as typed/,
      }),
    )
    await waitFor(() => expect(mockCite).toHaveBeenCalledTimes(3))
    expect(mockCite).toHaveBeenNthCalledWith(3, 'hydrogin buses', {
      expansion: false,
    })
  })
})

describe('results page — empty and error states', () => {
  it('shows the spinner, not "No strong matches", while the search is in flight', async () => {
    let resolveCite: (v: any) => void = () => {}
    mockCite.mockReturnValueOnce(
      new Promise((res) => {
        resolveCite = res
      }),
    )

    renderPage('hydrogen')
    await waitFor(() => expect(mockCite).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/No strong matches/)).not.toBeInTheDocument()

    await act(async () => {
      resolveCite(citeResponse([], null))
    })
    await waitFor(() =>
      expect(screen.getByText(/No strong matches/)).toBeInTheDocument(),
    )
  })

  it('does not claim "No strong matches" when the request failed', async () => {
    mockCite.mockRejectedValueOnce(new Error('network down'))

    renderPage('hydrogen')
    await waitFor(() => expect(mockCite).toHaveBeenCalledTimes(1))
    // Give the rejection a tick to settle.
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText(/No strong matches/)).not.toBeInTheDocument()
  })
})

describe('results page — cache', () => {
  it('serves a repeat query from cache with its docs intact', async () => {
    mockCite
      .mockResolvedValueOnce(citeResponse([doc('a'), doc('b'), doc('c')], null))
      .mockResolvedValueOnce(citeResponse([doc('x'), doc('y'), doc('z')], null))

    const view = renderPage('first query')
    await waitFor(() =>
      expect(screen.getByTestId('cite-panel')).toHaveAttribute(
        'data-docs',
        '3',
      ),
    )

    currentQ = 'second query'
    view.rerender(
      <ChakraProvider>
        <ResultsPage />
      </ChakraProvider>,
    )
    await waitFor(() => expect(mockCite).toHaveBeenCalledTimes(2))

    currentQ = 'first query'
    view.rerender(
      <ChakraProvider>
        <ResultsPage />
      </ChakraProvider>,
    )
    // Cache hit: docs restored, no third network call, and no empty-state
    // flash from a docs-less cache entry.
    await waitFor(() =>
      expect(screen.getByTestId('cite-panel')).toHaveAttribute(
        'data-docs',
        '3',
      ),
    )
    expect(mockCite).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/No strong matches/)).not.toBeInTheDocument()
  })
})
