import type React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ExpertsPage from '@/app/experts/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { fetchExperts } from '@/lib/experts-client'
import type { ExpertsResponse } from '@/lib/experts/types'

// The URL is the page's single source of truth (U2), so the mock must behave
// like a real router: router.push rewrites the search string and every mounted
// useSearchParams re-renders from it. A static Map hid a double-fetch bug.
const mockSearchStore = {
  search: '',
  listeners: new Set<() => void>(),
  set(next: string) {
    mockSearchStore.search = next
    mockSearchStore.listeners.forEach((l) => l())
  },
  subscribe(l: () => void) {
    mockSearchStore.listeners.add(l)
    return () => {
      mockSearchStore.listeners.delete(l)
    }
  },
  get() {
    return mockSearchStore.search
  },
}
const routerPush = jest.fn((url: string) => {
  mockSearchStore.set(url.split('?')[1] ?? '')
})
jest.mock('next/navigation', () => {
  const react = jest.requireActual<typeof React>('react')
  return {
    useRouter: () => ({
      push: routerPush,
      replace: jest.fn(),
      prefetch: jest.fn(),
    }),
    usePathname: () => '/experts',
    useSearchParams: () => {
      const search = react.useSyncExternalStore(
        mockSearchStore.subscribe,
        mockSearchStore.get,
        mockSearchStore.get,
      )
      return react.useMemo(() => new URLSearchParams(search), [search])
    },
  }
})
jest.mock('@/lib/experts-client', () => ({ fetchExperts: jest.fn() }))
jest.mock('@/app/components/Experts/TopicGraph', () => ({
  TopicGraph: (p: any) => (
    <div
      data-testid='graph'
      data-selected={p.selectedKey ?? ''}
      data-hover={p.hoverKey ?? ''}
      data-topics-degraded={String(!!p.topicsAreDerived)}
      data-hover-topic={p.hoverTopic ?? ''}
    />
  ),
}))
const setUrl = (search: string) => {
  act(() => mockSearchStore.set(search))
}
const mockFetch = fetchExperts as jest.Mock

const response = (over: Partial<ExpertsResponse> = {}): ExpertsResponse => ({
  ok: true,
  query: 'electric buses',
  mode: 'evidence',
  understanding: {
    matched_topics: [{ label: 'Buses', cosine: 0.66, df: 19 }],
    matched_geographies: [],
    likely_off_topic: false,
    suggestions: [],
    degraded: [],
  },
  people: [
    {
      key: 'xue, lulu',
      name: 'Xue, Lulu',
      office: 'WRI China',
      offices: { 'WRI China': 3 },
      score: 1,
      evidence: {
        docs: 3,
        strong: 2,
        partial: 1,
        weak: 0,
        years: [2020, 2025],
        corpusDocs: 27,
      },
      topics: [{ label: 'Buses', n: 3, matched: true }],
      docIds: ['d1'],
    },
    {
      key: 'sclar, ryan',
      name: 'Sclar, Ryan',
      office: 'WRI Global',
      offices: { 'WRI Global': 1 },
      score: 0.5,
      evidence: {
        docs: 1,
        strong: 1,
        partial: 0,
        weak: 0,
        years: [2021, 2021],
        corpusDocs: 8,
      },
      topics: [{ label: 'Buses', n: 2, matched: true }],
      docIds: ['d2'],
    },
  ],
  total_people: 2,
  total_works: 201,
  docs: {
    d1: {
      docId: 'd1',
      title: 'Bus paper',
      year: 2025,
      type: 'Report',
      office: 'WRI China',
      tier: 'strong',
      url: null,
      authors: [{ key: 'xue, lulu', name: 'Xue, Lulu', org: false }],
      topics: ['Buses'],
      geographies: [],
      translations: [],
    },
    d2: {
      docId: 'd2',
      title: 'Other',
      year: 2021,
      type: 'Report',
      office: 'WRI Global',
      tier: 'strong',
      url: null,
      authors: [{ key: 'sclar, ryan', name: 'Sclar, Ryan', org: false }],
      topics: ['Buses'],
      geographies: [],
      translations: [],
    },
  },
  organizations: [{ name: 'Coalition for Urban Transitions', docs: 9 }],
  usage: null,
  timing: {},
  ...over,
})

beforeEach(() => {
  mockSearchStore.search = ''
  routerPush.mockClear()
  mockFetch.mockReset()
  // jsdom's global has neither fetch nor Response (and jest.spyOn throws on
  // a missing property), so assign a jest.fn directly — the same pattern as
  // src/__tests__/results-page.test.tsx. The page fire-and-forgets the
  // query-log POST, so a Response-like object suffices.
  ;(global as any).fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, status: 201 }) // query log
})
afterEach(() => jest.restoreAllMocks())

const renderPage = () =>
  render(
    <ChakraProvider>
      <ExpertsPage />
    </ChakraProvider>,
  )

describe('/experts page', () => {
  it('idle: shows the staff banner, suggestions, and submits to ?q=', async () => {
    // The push really navigates now (the mock store drives useSearchParams),
    // so the submit kicks off a fetch that must settle inside act().
    mockFetch.mockResolvedValue(response())
    renderPage()
    expect(screen.getByText(/For WRI staff use only/)).toBeInTheDocument()
    const input = screen.getByLabelText('Expertise query input')
    fireEvent.change(input, { target: { value: 'electric buses' } })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Find people'))
    })
    expect(routerPush).toHaveBeenCalledWith('/experts?q=electric%20buses')
  })

  it('results: renders list, chips, summary, organizations; selecting opens evidence and updates URL', async () => {
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(response())
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    expect(mockFetch).toHaveBeenCalledWith({
      query: 'electric buses',
      excluded_topics: [],
    })
    expect(screen.getByText(/2 people across 2 offices/)).toBeInTheDocument()
    expect(
      screen.getByText(/Coalition for Urban Transitions/),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Xue, Lulu/ }))
    expect(
      await screen.findByRole('heading', { name: 'Xue, Lulu' }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('graph')).toHaveAttribute(
      'data-selected',
      'xue, lulu',
    )
    expect(routerPush).toHaveBeenLastCalledWith(
      '/experts?q=electric%20buses&person=xue%2C%20lulu',
    )
  })

  it('logs the query once after results', async () => {
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(response())
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/experts-mode-query-logs',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect(body).toEqual({
      query: 'electric buses',
      mode: 'evidence',
      topTenPeople: JSON.stringify(['Xue, Lulu', 'Sclar, Ryan']),
    })
  })

  it('removing a topic chip re-queries with excluded_topics and updates URL', async () => {
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(response())
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove Buses' }))
    await waitFor(() =>
      expect(mockFetch).toHaveBeenLastCalledWith({
        query: 'electric buses',
        excluded_topics: ['Buses'],
      }),
    )
    expect(routerPush).toHaveBeenLastCalledWith(
      '/experts?q=electric%20buses&exclude=Buses',
    )
  })

  it('U2: removing a chip fetches exactly once — the URL is the only trigger', async () => {
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(response())
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove Buses' }))
    })
    await waitFor(() =>
      expect(mockFetch).toHaveBeenLastCalledWith({
        query: 'electric buses',
        excluded_topics: ['Buses'],
      }),
    )
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('I-4: removing a hovered chip clears the hover it left behind', async () => {
    // The remove control sets hoverTopic on focus and clears it on blur, but
    // clicking it unmounts the chip and React fires no blur on unmount. The
    // hover then pointed at a topic that is no longer in the interpretation
    // line, dimming every row that lacks it with no way to clear it.
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(response())
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    const remove = screen.getByRole('button', { name: 'Remove Buses' })
    fireEvent.focus(remove)
    expect(screen.getByTestId('graph')).toHaveAttribute(
      'data-hover-topic',
      'Buses',
    )
    mockFetch.mockResolvedValue(
      response({
        understanding: {
          matched_topics: [],
          matched_geographies: [],
          likely_off_topic: false,
          suggestions: [],
          degraded: [],
        },
      }),
    )
    await act(async () => {
      fireEvent.click(remove)
    })
    await waitFor(() =>
      expect(screen.getByTestId('graph')).toHaveAttribute(
        'data-hover-topic',
        '',
      ),
    )
  })

  it('U6: a topic label containing a comma survives a round-trip through the URL', async () => {
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(
      response({
        understanding: {
          matched_topics: [{ label: 'Transport, Urban', cosine: 0.5, df: 9 }],
          matched_geographies: [],
          likely_off_topic: false,
          suggestions: [],
          degraded: [],
        },
      }),
    )
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove Transport, Urban' }),
      )
    })
    await waitFor(() =>
      expect(mockFetch).toHaveBeenLastCalledWith({
        query: 'electric buses',
        excluded_topics: ['Transport, Urban'],
      }),
    )
    expect(routerPush).toHaveBeenLastCalledWith(
      '/experts?q=electric%20buses&exclude=Transport%2C%20Urban',
    )
  })

  it('U7: removing a chip does not reset in-progress typing in the textarea', async () => {
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(response())
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    const input = screen.getByLabelText('Expertise query input')
    fireEvent.change(input, { target: { value: 'hydrogen ferries' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove Buses' }))
    })
    expect(input).toHaveValue('hydrogen ferries')
  })

  it('topic_only: shows the silent-corpus banner', async () => {
    setUrl('q=quantum+transit')
    mockFetch.mockResolvedValue(
      response({ mode: 'topic_only', query: 'quantum transit' }),
    )
    renderPage()
    expect(
      await screen.findByText(/No direct matches for “quantum transit”/),
    ).toBeInTheDocument()
  })

  it('U3: names the degraded topic facet and stops showing derived strengths', async () => {
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(
      response({
        understanding: {
          matched_topics: [{ label: 'Climate Resilience', cosine: 1, df: 19 }],
          matched_geographies: [],
          likely_off_topic: false,
          suggestions: [],
          degraded: ['tags_nearby:topic'],
        },
      }),
    )
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    expect(
      screen.getByText(/Topic matching is unavailable/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        /taken from the matched documents' own tags, so they are not query match strengths/,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('1.00')).not.toBeInTheDocument()
    expect(screen.getByTestId('graph')).toHaveAttribute(
      'data-topics-degraded',
      'true',
    )
  })

  it('U3: names a degraded /query and leaves real cosines alone', async () => {
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(
      response({
        mode: 'topic_only',
        understanding: {
          matched_topics: [{ label: 'Buses', cosine: 0.66, df: 19 }],
          matched_geographies: [],
          likely_off_topic: false,
          suggestions: [],
          degraded: ['query'],
        },
      }),
    )
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    expect(
      screen.getByText(/Document search is unavailable/),
    ).toBeInTheDocument()
    expect(screen.getByText('0.66')).toBeInTheDocument()
    expect(screen.getByTestId('graph')).toHaveAttribute(
      'data-topics-degraded',
      'false',
    )
  })

  it('M-5: a failed re-query does not show the error over a stale ranked list', async () => {
    // Spec §7's error state preserves the query and the chips — not the
    // previous bench. Showing "We could not load people" directly above a full,
    // confident-looking ranking invites the reader to trust results that are
    // not answers to the question in the box.
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(response())
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    mockFetch.mockRejectedValue(new Error('boom'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove Buses' }))
    })
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.queryByTestId('experts-bench')).not.toBeInTheDocument()
  })

  it('I-1: a no-match is not reported as an outage, but is still explained', async () => {
    // The search service treats "covered facet, nothing above the cosine floor"
    // as a healthy empty answer, not a degradation. Saying "Topic matching is
    // unavailable" for it would be false — but the chips ARE doc-derived, so
    // silence would be worse.
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(
      response({
        understanding: {
          matched_topics: [{ label: 'Buses', cosine: 1, df: 19 }],
          matched_geographies: [],
          likely_off_topic: false,
          suggestions: [],
          degraded: ['tags_nearby:topic_no_match'],
        },
      }),
    )
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    expect(
      screen.queryByText(/Topic matching is unavailable/),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/No topic in the library matched this question/),
    ).toBeInTheDocument()
    // still doc-derived, so the strength must not read as a cosine
    expect(screen.queryByText('1.00')).not.toBeInTheDocument()
  })

  it('I-3: the visible graph caption stops claiming a query match when derived', async () => {
    // U18 fixed the SVG aria-label, but the sighted caption above the graph
    // was unconditional — the accessible name and the on-screen text said
    // opposite things about the same circles.
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(
      response({
        understanding: {
          matched_topics: [{ label: 'Buses', cosine: 1, df: 19 }],
          matched_geographies: [],
          likely_off_topic: false,
          suggestions: [],
          degraded: ['tags_nearby:topic'],
        },
      }),
    )
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    expect(
      screen.queryByText(/topics sized by match to the query/),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/topics from the matched documents/),
    ).toBeInTheDocument()
  })

  it('U3: renders no degradation notice when nothing degraded', async () => {
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(response())
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    expect(
      screen.queryByText(/Topic matching is unavailable/),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Document search is unavailable/),
    ).not.toBeInTheDocument()
  })

  it('U4: the summary line describes ONE population when the list is truncated', async () => {
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(response({ total_people: 38 }))
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    // 38 is corpus-wide; the 2 offices and 2 documents describe the shown 2.
    // A single text node (deliberate earlier fix) — no nested <b> around numbers.
    expect(
      screen.getByText(
        '38 people match. Showing the top 2 — across 2 offices, on 2 documents.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/38 people across 2 offices/)).toBeNull()
  })

  it('U4: says it plainly when nothing is truncated', async () => {
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(response())
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    expect(
      screen.getByText('2 people across 2 offices, on 2 documents that match.'),
    ).toBeInTheDocument()
  })

  it('U21: off-topic topic_only says less than "no direct matches"', async () => {
    setUrl('q=quantum+transit')
    mockFetch.mockResolvedValue(
      response({
        mode: 'topic_only',
        query: 'quantum transit',
        understanding: {
          matched_topics: [{ label: 'Buses', cosine: 0.66, df: 19 }],
          matched_geographies: [],
          likely_off_topic: true,
          suggestions: [],
          degraded: [],
        },
      }),
    )
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    expect(screen.queryByText(/No direct matches for/)).not.toBeInTheDocument()
    expect(
      screen.getByText(
        /“quantum transit” does not look like a topic this corpus covers/,
      ),
    ).toBeInTheDocument()
  })

  it('U14: focusing a topic chip from the keyboard reaches the graph, not just the list', async () => {
    // Spec §8 makes the list the graph's table twin and requires every
    // interaction to be keyboard-reachable. Topic hover used to live in
    // TopicGraph's own state, so a chip could highlight the list while the
    // graph sat inert — half the surface responding to the same gesture.
    setUrl('q=electric+buses')
    mockFetch.mockResolvedValue(response())
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('graph')).toHaveAttribute('data-hover-topic', '')
    fireEvent.focus(screen.getByRole('button', { name: 'Remove Buses' }))
    expect(screen.getByTestId('graph')).toHaveAttribute(
      'data-hover-topic',
      'Buses',
    )
  })

  it('nothing: shows the empty state with nearby topics', async () => {
    setUrl('q=zzz')
    mockFetch.mockResolvedValue(
      response({
        mode: 'topic_only',
        people: [],
        total_people: 0,
        docs: {},
        organizations: [],
        understanding: {
          matched_topics: [],
          matched_geographies: [],
          likely_off_topic: true,
          suggestions: [{ type: 'nearby_topic', text: 'Buses' }],
          degraded: [],
        },
      }),
    )
    renderPage()
    expect(
      await screen.findByText(/No one in the corpus has published near this/),
    ).toBeInTheDocument()
    // Picking a nearby topic navigates, which starts a fetch — settle it here.
    await act(async () => {
      fireEvent.click(screen.getByText('Buses'))
    })
    expect(routerPush).toHaveBeenCalledWith('/experts?q=Buses')
  })

  it('U9: first load shows skeleton rows and a graph card with a spinner', async () => {
    let resolve!: (v: ExpertsResponse) => void
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<ExpertsResponse>((r) => {
          resolve = r
        }),
    )
    setUrl('q=electric+buses')
    renderPage()
    expect(await screen.findByTestId('experts-skeleton')).toBeInTheDocument()
    expect(screen.getByTestId('experts-graph-skeleton')).toBeInTheDocument()
    await act(async () => {
      resolve(response())
    })
    expect(screen.queryByTestId('experts-skeleton')).not.toBeInTheDocument()
  })

  it('U9: on a re-query the stale chips and summary dim with the bench', async () => {
    mockFetch.mockResolvedValue(response())
    setUrl('q=electric+buses')
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    let resolve!: (v: ExpertsResponse) => void
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<ExpertsResponse>((r) => {
          resolve = r
        }),
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove Buses' }))
    })
    const stale = screen.getByTestId('experts-interpretation')
    expect(stale).toHaveStyle({ opacity: '0.6' })
    expect(screen.getByTestId('experts-bench')).toHaveStyle({ opacity: '0.6' })
    await act(async () => {
      resolve(response())
    })
    expect(screen.getByTestId('experts-interpretation')).toHaveStyle({
      opacity: '1',
    })
  })

  it('U10: the nothing state says it once', async () => {
    setUrl('q=zzz')
    mockFetch.mockResolvedValue(
      response({
        mode: 'topic_only',
        people: [],
        total_people: 0,
        docs: {},
        organizations: [],
        understanding: {
          matched_topics: [],
          matched_geographies: [],
          likely_off_topic: true,
          suggestions: [{ type: 'nearby_topic', text: 'Buses' }],
          degraded: [],
        },
      }),
    )
    renderPage()
    expect(
      await screen.findByText(/No one in the corpus has published near this/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/No strong matches for/)).not.toBeInTheDocument()
  })

  it('U19: a payload missing optional arrays does not white-screen', async () => {
    setUrl('q=electric+buses')
    const partial = response()
    delete (partial.understanding as any).matched_geographies
    delete (partial.understanding as any).suggestions
    delete (partial as any).organizations
    mockFetch.mockResolvedValue(partial)
    renderPage()
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
    expect(screen.queryByText(/Also publishing on this/)).toBeNull()
  })

  it('U19: a nothing-state payload with no suggestions array still renders', async () => {
    setUrl('q=zzz')
    const partial = response({
      mode: 'topic_only',
      people: [],
      total_people: 0,
      docs: {},
    })
    delete (partial.understanding as any).suggestions
    mockFetch.mockResolvedValue(partial)
    renderPage()
    expect(
      await screen.findByText(/No one in the corpus has published near this/),
    ).toBeInTheDocument()
  })

  it('U1: a slower earlier request never overwrites a newer one', async () => {
    let resolveA!: (v: ExpertsResponse) => void
    let resolveB!: (v: ExpertsResponse) => void
    mockFetch
      .mockImplementationOnce(
        () =>
          new Promise<ExpertsResponse>((r) => {
            resolveA = r
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ExpertsResponse>((r) => {
            resolveB = r
          }),
      )
    setUrl('q=A')
    renderPage()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    setUrl('q=B')
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))

    // B (the newer query) comes back first.
    await act(async () => {
      resolveB(
        response({
          query: 'B',
          people: [
            { ...response().people[0], key: 'bee, bea', name: 'Bee, Bea' },
          ],
        }),
      )
    })
    expect(await screen.findByText('Bee, Bea')).toBeInTheDocument()

    // A (the older query) resolves afterwards and must be discarded.
    await act(async () => {
      resolveA(response({ query: 'A' }))
    })
    expect(screen.getByText('Bee, Bea')).toBeInTheDocument()
    expect(screen.queryByText('Xue, Lulu')).not.toBeInTheDocument()
  })

  it('U1: a slower earlier failure never replaces newer results with an error', async () => {
    let rejectA!: (e: Error) => void
    let resolveB!: (v: ExpertsResponse) => void
    mockFetch
      .mockImplementationOnce(
        () =>
          new Promise<ExpertsResponse>((_r, rej) => {
            rejectA = rej
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ExpertsResponse>((r) => {
            resolveB = r
          }),
      )
    setUrl('q=A')
    renderPage()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    setUrl('q=B')
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    await act(async () => {
      resolveB(response({ query: 'B' }))
    })
    expect(await screen.findByText('Xue, Lulu')).toBeInTheDocument()
    await act(async () => {
      rejectA(new Error('boom'))
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Xue, Lulu')).toBeInTheDocument()
  })

  it('U8: error shows a fixed user-facing message, never raw upstream copy, and retries', async () => {
    setUrl('q=x')
    mockFetch
      .mockRejectedValueOnce(new Error('experts request failed (500)'))
      .mockResolvedValueOnce(response())
    renderPage()
    expect(
      await screen.findByText(/We could not load people for this question/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/experts request failed/)).not.toBeInTheDocument()
    expect(screen.queryByText(/internal error/)).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
  })

  it('U8: the error state preserves the query and the exclude chips', async () => {
    setUrl('q=electric+buses&exclude=Buses')
    mockFetch.mockRejectedValue(new Error('internal error'))
    renderPage()
    expect(
      await screen.findByText(/We could not load people for this question/),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Expertise query input')).toHaveValue(
      'electric buses',
    )
    expect(mockFetch).toHaveBeenCalledWith({
      query: 'electric buses',
      excluded_topics: ['Buses'],
    })
  })

  it('U16: the topic_only banner uses the design-system amber, not ad-hoc hexes', async () => {
    setUrl('q=quantum+transit')
    mockFetch.mockResolvedValue(
      response({ mode: 'topic_only', query: 'quantum transit' }),
    )
    renderPage()
    const banner = await screen.findByText(
      /No direct matches for “quantum transit”/,
    )
    const html = banner.closest('div')?.outerHTML ?? ''
    expect(html).not.toMatch(/#fcf8e3|#faebcc|#8a6d3b/i)
  })
})
