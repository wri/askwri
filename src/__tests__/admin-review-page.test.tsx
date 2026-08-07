import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ReviewQueuePage from '@/app/admin/review/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

jest.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
  }),
  usePathname: () => '/admin/review',
  useSearchParams: () => ({ get: () => null }),
}))

const mockItems = [
  {
    id: 'd1',
    externalId: 'ext-1',
    title: 'Doc One',
    language: 'en',
    status: 'needs_review',
    extractionConfidence: 0.5,
    jobStatus: null,
    jobError: null,
    jobAttempts: null,
    suggestedTagCount: 2,
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'd2',
    externalId: 'ext-2',
    title: 'Doc Two',
    language: 'en',
    status: 'needs_review',
    extractionConfidence: 0.6,
    jobStatus: null,
    jobError: null,
    jobAttempts: null,
    suggestedTagCount: 1,
    createdAt: '2026-01-02T00:00:00Z',
  },
  {
    id: 'd3',
    externalId: 'ext-3',
    title: 'Doc Three',
    language: 'en',
    status: 'error',
    extractionConfidence: null,
    jobStatus: 'error',
    jobError: 'worker crashed',
    jobAttempts: 3,
    suggestedTagCount: 0,
    createdAt: '2026-01-03T00:00:00Z',
  },
]

const mockHealth = {
  ok: true,
  health: {
    statusCounts: {},
    languageCounts: {},
    reviewQueueDepth: 3,
    docsMissingNativeSummary: 0,
    docsMissingTitleEn: 0,
    lowConfidenceDocs: 0,
    worker: {
      status: 'idle',
      queueDepth: 0,
      intakeBacklog: 0,
      lastProcessedAt: null,
    },
  },
}

const setupFetchMock = (actionOverrides: Record<string, any> = {}) => {
  const fetchMock = jest.fn((url: string) => {
    if (url === '/api/admin/review-queue') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, items: mockItems }),
      })
    }
    if (url === '/api/admin/corpus-health') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockHealth),
      })
    }
    const overrideKey = Object.keys(actionOverrides).find((k) =>
      url.endsWith(k),
    )
    if (overrideKey) {
      const override = actionOverrides[overrideKey]
      return Promise.resolve({
        ok: override.ok !== false,
        status: override.ok === false ? 409 : 200,
        json: () => Promise.resolve(override),
      })
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    })
  })
  global.fetch = fetchMock as any
  return fetchMock
}

const renderPage = () =>
  render(
    <ChakraProvider>
      <ReviewQueuePage />
    </ChakraProvider>,
  )

describe('ReviewQueuePage (jsdom)', () => {
  it('renders a checkbox per row and a select-all header checkbox', async () => {
    setupFetchMock()
    renderPage()

    await screen.findByText('Doc One')

    const checkboxes = screen.getAllByRole('checkbox')
    // 1 header select-all + 3 row checkboxes
    expect(checkboxes).toHaveLength(4)
    expect(
      screen.getByRole('checkbox', { name: 'Select all' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('checkbox', { name: 'Select Doc One' }),
    ).toBeInTheDocument()
  })

  it('shows the bulk bar only when rows are selected', async () => {
    setupFetchMock()
    renderPage()

    await screen.findByText('Doc One')
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Doc One' }))

    expect(await screen.findByText('1 selected')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Promote 1' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Re-ingest 1' }),
    ).toBeInTheDocument()
  })

  it('bulk-promotes selected rows after confirm and reports the summary', async () => {
    const fetchMock = setupFetchMock()
    window.confirm = jest.fn(() => true)
    renderPage()

    await screen.findByText('Doc One')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Doc One' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Doc Two' }))

    const promoteButton = await screen.findByRole('button', {
      name: 'Promote 2',
    })
    fireEvent.click(promoteButton)

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('2'))

    await waitFor(() => {
      expect(screen.getByText(/2 promoted/)).toBeInTheDocument()
    })

    const calledUrls = fetchMock.mock.calls.map((c) => c[0])
    expect(calledUrls).toContain('/api/admin/documents/d1/status')
    expect(calledUrls).toContain('/api/admin/documents/d2/status')

    const d1Call = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/admin/documents/d1/status',
    )
    expect(d1Call?.[1]?.body).toBe(JSON.stringify({ status: 'searchable' }))
  })

  it('keeps failed rows selected and lists reasons on partial failure', async () => {
    setupFetchMock({
      '/documents/d2/reingest': {
        ok: false,
        error: 'an open ingestion job already exists',
      },
    })
    window.confirm = jest.fn(() => true)
    renderPage()

    await screen.findByText('Doc One')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Doc One' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Doc Two' }))

    const reingestButton = await screen.findByRole('button', {
      name: 'Re-ingest 2',
    })
    fireEvent.click(reingestButton)

    await waitFor(() => {
      expect(
        screen.getByText(/Doc Two: an open ingestion job already exists/),
      ).toBeInTheDocument()
    })
    expect(screen.getByText(/1 re-queued, 1 failed/)).toBeInTheDocument()

    expect(
      screen.getByRole('checkbox', { name: 'Select Doc One' }),
    ).not.toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: 'Select Doc Two' }),
    ).toBeChecked()
  })

  it('clears the selection after a fully successful bulk promote', async () => {
    setupFetchMock()
    window.confirm = jest.fn(() => true)
    renderPage()

    await screen.findByText('Doc One')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Doc One' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Doc Two' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Promote 2' }))

    await waitFor(() => {
      expect(screen.getByText(/2 promoted/)).toBeInTheDocument()
    })

    // Selection cleared → bulk bar gone
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
    expect(
      screen.getByRole('checkbox', { name: 'Select Doc One' }),
    ).not.toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: 'Select Doc Two' }),
    ).not.toBeChecked()
  })

  it('disables bulk Promote when the selection includes an error-status doc', async () => {
    setupFetchMock()
    renderPage()

    await screen.findByText('Doc Three')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Doc Three' })) // d3, status = error

    const promoteButton = await screen.findByRole('button', {
      name: 'Promote 1',
    })
    expect(promoteButton).toBeDisabled()
    expect(promoteButton).toHaveAttribute(
      'title',
      expect.stringContaining('error'),
    )

    const reingestButton = screen.getByRole('button', { name: 'Re-ingest 1' })
    expect(reingestButton).not.toBeDisabled()
  })

  it('shows a loading line before the queue resolves', () => {
    setupFetchMock()
    render(
      <ChakraProvider>
        <ReviewQueuePage />
      </ChakraProvider>,
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('renders a Start reviewing button linking to the first queue doc', async () => {
    setupFetchMock()
    renderPage()

    const link = await screen.findByRole('link', {
      name: /Start reviewing \(3\)/,
    })
    expect(link).toHaveAttribute('href', '/admin/documents/d1')
  })
})
