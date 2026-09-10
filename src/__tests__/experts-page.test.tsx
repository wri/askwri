import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ExpertsPage from '@/app/experts/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'
import { fetchExperts } from '@/lib/experts-client'
import type { ExpertsResponse } from '@/lib/experts/types'

const params = new Map<string, string>()
const routerPush = jest.fn()
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerPush,
    replace: jest.fn(),
    prefetch: jest.fn(),
  }),
  usePathname: () => '/experts',
  useSearchParams: () => ({
    get: (k: string) => params.get(k) ?? null,
    toString: () => '',
  }),
}))
jest.mock('@/lib/experts-client', () => ({ fetchExperts: jest.fn() }))
jest.mock('@/app/components/Experts/TopicGraph', () => ({
  TopicGraph: (p: any) => (
    <div
      data-testid='graph'
      data-selected={p.selectedKey ?? ''}
      data-hover={p.hoverKey ?? ''}
    />
  ),
}))
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
  params.clear()
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
  it('idle: shows the staff banner, suggestions, and submits to ?q=', () => {
    renderPage()
    expect(screen.getByText(/For WRI staff use only/)).toBeInTheDocument()
    const input = screen.getByLabelText('Expertise query input')
    fireEvent.change(input, { target: { value: 'electric buses' } })
    fireEvent.click(screen.getByLabelText('Find people'))
    expect(routerPush).toHaveBeenCalledWith('/experts?q=electric%20buses')
  })

  it('results: renders list, chips, summary, organizations; selecting opens evidence and updates URL', async () => {
    params.set('q', 'electric buses')
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
    params.set('q', 'electric buses')
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
    params.set('q', 'electric buses')
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

  it('topic_only: shows the silent-corpus banner', async () => {
    params.set('q', 'quantum transit')
    mockFetch.mockResolvedValue(
      response({ mode: 'topic_only', query: 'quantum transit' }),
    )
    renderPage()
    expect(
      await screen.findByText(/No direct matches for “quantum transit”/),
    ).toBeInTheDocument()
  })

  it('nothing: shows the empty state with nearby topics', async () => {
    params.set('q', 'zzz')
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
    fireEvent.click(screen.getByText('Buses'))
    expect(routerPush).toHaveBeenCalledWith('/experts?q=Buses')
  })

  it('error: shows a retry that re-fetches', async () => {
    params.set('q', 'x')
    mockFetch
      .mockRejectedValueOnce(new Error('search service unavailable'))
      .mockResolvedValueOnce(response())
    renderPage()
    expect(
      await screen.findByText(/search service unavailable/),
    ).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    await waitFor(() =>
      expect(screen.getByText('Xue, Lulu')).toBeInTheDocument(),
    )
  })
})
