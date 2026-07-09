import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from '@testing-library/react'
import '@testing-library/jest-dom'
import DocumentEditorPage from '@/app/admin/documents/[id]/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

// Mock next/navigation (useParams). `mockRouterPush` is a shared spy so tests can
// assert navigation; the `mock` prefix lets Jest reference it in the hoisted factory.
const mockRouterPush = jest.fn()
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'test-doc-id-123' }),
  useRouter: () => ({
    push: mockRouterPush,
    replace: jest.fn(),
    refresh: jest.fn(),
  }),
  usePathname: () => '/admin/documents/test-doc-id-123',
  useSearchParams: () => ({ get: () => null }),
}))

// Mock adminFetch via global fetch — the page uses adminFetch which wraps fetch,
// and also raw fetch for /api/admin/auth/me.
const mockDocument = {
  id: 'test-doc-id-123',
  externalId: 'test-doc',
  title: 'Test Document',
  titleEn: 'Test Document',
  doi: '10.1234/test',
  authors: 'Doe, Jane; Smith, John',
  url: 'https://example.com/test',
  datePublished: '2024-01-15',
  language: 'en',
  languages: ['en'],
  yearPublished: 2024,
  publicationTitle: 'Test Publication',
  articleType: 'Report',
  wriPrimaryOffice: 'WRI India',
  status: 'searchable',
  extractionConfidence: '1.00',
  metadataSource: { title: 'llm', authors: 'human' },
  sourceMetadata: {
    file_path: 'test-doc.pdf',
    summary: 'A test summary.',
    metadata: {
      'Article Title': 'Test Document',
      'All authors': 'Doe, Jane; Smith, John',
      URL: 'https://example.com/test',
      'Date published': '1/15/2024',
      DOI: '10.1234/test',
    },
  },
}

const mockDetail = {
  document: mockDocument,
  summaries: [
    {
      language: 'en',
      kind: 'long',
      text: 'A long English summary.',
      source: 'external',
    },
    {
      language: 'en',
      kind: 'short',
      text: 'A short summary.',
      source: 'external',
    },
  ],
  tags: [],
  collections: [],
  latestJob: null,
}

function setupFetchMock(
  documentOverride?: Record<string, any>,
  queueItems: any[] = [],
) {
  const detail = documentOverride
    ? { ...mockDetail, document: { ...mockDocument, ...documentOverride } }
    : mockDetail
  const fetchMock = jest.fn((url: string, _init?: RequestInit) => {
    // adminFetch calls fetch with the path directly; auth/me uses raw fetch
    if (url === '/api/admin/auth/me') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ identity: { username: 'admin', role: 'admin' } }),
      } as any)
    }
    if (url === '/api/admin/review-queue') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, items: queueItems }),
      } as any)
    }
    if (url === '/api/admin/tags') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, tags: [] }),
      } as any)
    }
    if (url === '/api/admin/collections') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, collections: [] }),
      } as any)
    }
    if (url.startsWith('/api/admin/documents/test-doc-id-123')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(detail),
      } as any)
    }
    // Default: empty ok response
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as any)
  })
  global.fetch = fetchMock as any
  return fetchMock
}

describe('DocumentEditorPage', () => {
  beforeEach(() => {
    setupFetchMock()
    mockRouterPush.mockClear()
  })

  it('renders an Authors field (textarea)', async () => {
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('Authors')).toBeInTheDocument()
    })
  })

  it('renders a URL field (input)', async () => {
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('URL')).toBeInTheDocument()
    })
  })

  it('renders a Date published field', async () => {
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('Date published')).toBeInTheDocument()
    })
  })

  it('does NOT render an Abstract field', async () => {
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('Authors')).toBeInTheDocument()
    })
    expect(screen.queryByText('Abstract')).not.toBeInTheDocument()
  })

  it('renders a Source metadata (read-only) section', async () => {
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(
        screen.getByText(/Original imported metadata \(read-only\)/i),
      ).toBeInTheDocument()
    })
  })

  it('renders edit controls in the Summaries panel', async () => {
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await waitFor(() => {
      // The summaries panel should have editable textareas (not just read-only divs)
      expect(screen.getByText('Summaries')).toBeInTheDocument()
    })
    // There should be a "Save summaries" button or textarea elements within summaries
    await waitFor(() => {
      const summaryTextareas = document.querySelectorAll(
        'textarea[data-summary-key]',
      )
      expect(summaryTextareas.length).toBeGreaterThan(0)
    })
  })

  it('renders a Delete button for admins in the lifecycle panel', async () => {
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('Delete')).toBeInTheDocument()
    })
  })

  it('shows a provenance badge for AI-extracted and human-edited fields', async () => {
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    expect(await screen.findByText('AI')).toBeInTheDocument()
    expect(screen.getByText('person')).toBeInTheDocument()
  })

  it('renders Language as a dropdown of supported languages', async () => {
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    const select = await screen.findByLabelText(/language/i)
    expect(select.tagName).toBe('SELECT')
    await waitFor(() => {
      expect(select).toHaveDisplayValue(/English/)
    })
  })

  it('keeps an out-of-list language visible as an unsupported option', async () => {
    setupFetchMock({ language: 'fr' })
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    const select = await screen.findByLabelText(/language/i)
    await waitFor(() => {
      expect(select).toHaveDisplayValue(/fr \(unsupported\)/)
    })
  })

  it('hides Promote for a draft document', async () => {
    setupFetchMock({ status: 'draft' })
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await screen.findByText('Document editor')
    expect(screen.queryByText('Promote')).not.toBeInTheDocument()
  })

  it('asks for confirmation before Withdraw', async () => {
    window.confirm = jest.fn(() => false)
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    fireEvent.click(await screen.findByText('Withdraw'))
    expect(window.confirm).toHaveBeenCalled()
  })

  it('shows no review bar when the doc is not in the review queue', async () => {
    setupFetchMock()
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await screen.findByText('Document editor')
    expect(screen.queryByText(/Reviewing \d+ of \d+/)).not.toBeInTheDocument()
  })

  it('shows position and controls when the doc is in the queue', async () => {
    setupFetchMock({ status: 'needs_review' }, [
      { id: 'other-1', status: 'needs_review' },
      { id: 'test-doc-id-123', status: 'needs_review' },
      { id: 'other-2', status: 'needs_review' },
    ])
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    expect(
      await screen.findByText('Reviewing 2 of 3 flagged'),
    ).toBeInTheDocument()
    const bar = within(screen.getByTestId('review-bar'))
    expect(bar.getByText('← Prev')).not.toBeDisabled()
    expect(bar.getByText('Skip →')).not.toBeDisabled()
  })

  it('advances to the next queue doc after Promote succeeds', async () => {
    const fetchMock = setupFetchMock({ status: 'needs_review' }, [
      { id: 'other-1', status: 'needs_review' },
      { id: 'test-doc-id-123', status: 'needs_review' },
      { id: 'other-2', status: 'needs_review' },
    ])
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    const bar = within(await screen.findByTestId('review-bar'))
    fireEvent.click(bar.getByText('Promote'))
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/admin/documents/other-2')
    })
    expect(
      fetchMock.mock.calls.some(
        (c: any[]) => c[0] === '/api/admin/documents/test-doc-id-123/status',
      ),
    ).toBe(true)
  })

  it('Skip navigates without acting', async () => {
    const fetchMock = setupFetchMock({ status: 'needs_review' }, [
      { id: 'other-1', status: 'needs_review' },
      { id: 'test-doc-id-123', status: 'needs_review' },
      { id: 'other-2', status: 'needs_review' },
    ])
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    const bar = within(await screen.findByTestId('review-bar'))
    fireEvent.click(bar.getByText('Skip →'))
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/admin/documents/other-2')
    })
    expect(
      fetchMock.mock.calls.some(
        (c: any[]) =>
          c[0] === '/api/admin/documents/test-doc-id-123/status' ||
          c[0] === '/api/admin/documents/test-doc-id-123/reingest',
      ),
    ).toBe(false)
  })

  it('disables Prev at the first position and Skip at the last', async () => {
    setupFetchMock({ status: 'needs_review' }, [
      { id: 'test-doc-id-123', status: 'needs_review' },
    ])
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    const bar = within(await screen.findByTestId('review-bar'))
    expect(bar.getByText('← Prev')).toBeDisabled()
    expect(bar.getByText('Skip →')).toBeDisabled()
    expect(bar.getByText('Promote')).not.toBeDisabled()
  })

  it('shows the not-in-queue notice with a Next button when the queue has other docs but not this one', async () => {
    setupFetchMock({ status: 'searchable' }, [
      { id: 'other-1', status: 'needs_review' },
    ])
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    const bar = within(await screen.findByTestId('review-bar'))
    expect(bar.getByText('No longer in the review queue.')).toBeInTheDocument()
    fireEvent.click(bar.getByText('Next →'))
    expect(mockRouterPush).toHaveBeenCalledWith('/admin/documents/other-1')
  })

  it('Re-ingest from the bar POSTs /reingest and advances to the next doc', async () => {
    const fetchMock = setupFetchMock({ status: 'needs_review' }, [
      { id: 'test-doc-id-123', status: 'needs_review' },
      { id: 'other-2', status: 'needs_review' },
    ])
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    const bar = within(await screen.findByTestId('review-bar'))
    fireEvent.click(bar.getByText('Re-ingest'))
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/admin/documents/other-2')
    })
    expect(
      fetchMock.mock.calls.some(
        (c: any[]) => c[0] === '/api/admin/documents/test-doc-id-123/reingest',
      ),
    ).toBe(true)
  })

  it('Promote on the last doc reloads the editor instead of navigating', async () => {
    const fetchMock = setupFetchMock({ status: 'needs_review' }, [
      { id: 'test-doc-id-123', status: 'needs_review' },
    ])
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    const bar = within(await screen.findByTestId('review-bar'))
    const detailCalls = () =>
      fetchMock.mock.calls.filter(
        (c: any[]) => c[0] === '/api/admin/documents/test-doc-id-123',
      ).length
    const before = detailCalls()
    fireEvent.click(bar.getByText('Promote'))
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          (c: any[]) => c[0] === '/api/admin/documents/test-doc-id-123/status',
        ),
      ).toBe(true)
    })
    // onChanged → load() refetches the detail endpoint; no navigation happens
    await waitFor(() => {
      expect(detailCalls()).toBeGreaterThan(before)
    })
    expect(mockRouterPush).not.toHaveBeenCalled()
  })

  it('renders panels in the approved order (Lifecycle first, Source metadata after Summaries)', async () => {
    setupFetchMock()
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await screen.findByText('Document editor')
    await screen.findByText(/Original imported metadata \(read-only\)/i)
    const markers = [
      'Lifecycle',
      'Metadata',
      'Tags',
      'Summaries',
      'Original imported metadata (read-only)',
      'Collections',
    ]
    const text = document.body.textContent ?? ''
    const idxs = markers.map((m) => text.indexOf(m))
    expect(idxs.every((v) => v >= 0)).toBe(true)
    expect([...idxs].sort((a, b) => a - b)).toEqual(idxs)
  })
})
