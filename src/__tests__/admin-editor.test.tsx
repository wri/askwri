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
// `mockParamsId` is mutable so tests can simulate in-place [id] navigation
// (the App Router keeps the page mounted across id changes).
const mockRouterPush = jest.fn()
let mockParamsId = 'test-doc-id-123'
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: mockParamsId }),
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

// Corpus vocabularies for the Article type / WRI primary office dropdowns.
const mockFieldValues = {
  articleType: ['Report', 'Technical Note', 'Working Paper'],
  wriPrimaryOffice: ['WRI China', 'WRI Global', 'WRI India'],
}

function setupFetchMock(
  documentOverride?: Record<string, any>,
  queueItems: any[] = [],
  history: { total: number; entries: any[] } = { total: 0, entries: [] },
  opts: { tags?: any[]; allTags?: any[] } = {},
) {
  // Never mutate mockDetail — it is shared across every test in the file.
  const detail = {
    ...mockDetail,
    ...(documentOverride
      ? { document: { ...mockDocument, ...documentOverride } }
      : {}),
    ...(opts.tags ? { tags: opts.tags } : {}),
  }
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
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
        json: () => Promise.resolve({ ok: true, tags: opts.allTags ?? [] }),
      } as any)
    }
    // MUST precede the broad '/api/admin/documents/' prefix branch below —
    // field-values is a sibling static segment, not a document id.
    if (url === '/api/admin/documents/field-values') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, ...mockFieldValues }),
      } as any)
    }
    if (url === '/api/admin/collections') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, collections: [] }),
      } as any)
    }
    // NOTE: this /history branch MUST precede the broad
    // '/api/admin/documents/test-doc-id-123' prefix branch below — otherwise
    // history fetches fall through to the document-detail payload.
    if (url.includes('/history')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, ...history }),
      } as any)
    }
    // Broad prefix: serves the detail payload for any document id so tests can
    // simulate navigating to a different [id] on the still-mounted page.
    // PATCH is the metadata save — it returns { updated }, not the detail.
    if (url.startsWith('/api/admin/documents/')) {
      if (init?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, updated: ['url'] }),
        } as any)
      }
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
    mockParamsId = 'test-doc-id-123'
  })

  it('shows a loading line (and no sections) before the document detail resolves', () => {
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    // Load-bearing assertion: the collapsed History panel ALREADY renders a
    // hidden 'Loading…' node in jsdom (page.tsx:1020-1022, RTL matches
    // non-visible text), so getByText alone is green before the gate exists.
    // Lifecycle renders synchronously today — its absence proves the gate.
    expect(screen.queryByText('Lifecycle')).not.toBeInTheDocument()
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

  // --- issue #304 -----------------------------------------------------------

  describe('dual title header', () => {
    it('shows the native title with the English title beneath it', async () => {
      setupFetchMock({
        title: '中国交通运输低碳发展',
        titleEn: 'Low-Carbon Development of Transport in China',
      })
      render(
        <ChakraProvider>
          <DocumentEditorPage />
        </ChakraProvider>,
      )
      await screen.findByText('中国交通运输低碳发展')
      expect(
        screen.getByText('Low-Carbon Development of Transport in China'),
      ).toBeInTheDocument()
    })

    it('shows the title once when the English title is identical', async () => {
      setupFetchMock({ title: 'Test Document', titleEn: 'Test Document' })
      render(
        <ChakraProvider>
          <DocumentEditorPage />
        </ChakraProvider>,
      )
      await screen.findByText('Document editor')
      // The Title / Title (EN) inputs also hold the string, so count only the
      // rendered text nodes in the header.
      expect(screen.getAllByText('Test Document')).toHaveLength(1)
    })
  })

  describe('metadata dropdowns', () => {
    it('renders Year published as a dropdown spanning 2000-2027', async () => {
      render(
        <ChakraProvider>
          <DocumentEditorPage />
        </ChakraProvider>,
      )
      const select = (await screen.findByLabelText(
        /year published/i,
      )) as HTMLSelectElement
      expect(select.tagName).toBe('SELECT')
      const values = Array.from(select.options).map((o) => o.value)
      expect(values).toContain('2000')
      expect(values).toContain('2027')
      expect(values).not.toContain('1999')
      expect(values).not.toContain('2028')
      expect(select).toHaveValue('2024')
    })

    it('keeps a stored year outside the range selectable', async () => {
      setupFetchMock({ yearPublished: 1998 })
      render(
        <ChakraProvider>
          <DocumentEditorPage />
        </ChakraProvider>,
      )
      const select = await screen.findByLabelText(/year published/i)
      await waitFor(() => expect(select).toHaveValue('1998'))
    })

    it('fills Article type and WRI primary office from the corpus values', async () => {
      render(
        <ChakraProvider>
          <DocumentEditorPage />
        </ChakraProvider>,
      )
      const articleType = (await screen.findByLabelText(
        /article type/i,
      )) as HTMLSelectElement
      await waitFor(() =>
        expect(Array.from(articleType.options).map((o) => o.value)).toEqual([
          '',
          ...mockFieldValues.articleType,
        ]),
      )
      expect(articleType).toHaveValue('Report')

      const office = (await screen.findByLabelText(
        /wri primary office/i,
      )) as HTMLSelectElement
      expect(Array.from(office.options).map((o) => o.value)).toEqual([
        '',
        ...mockFieldValues.wriPrimaryOffice,
      ])
      expect(office).toHaveValue('WRI India')
    })

    it('keeps a value absent from the corpus vocabulary selectable', async () => {
      setupFetchMock({ articleType: 'Field Guide' })
      render(
        <ChakraProvider>
          <DocumentEditorPage />
        </ChakraProvider>,
      )
      const select = await screen.findByLabelText(/article type/i)
      await waitFor(() => expect(select).toHaveValue('Field Guide'))
    })

    it('still lets the field be edited when the vocabulary fetch fails', async () => {
      const fetchMock = setupFetchMock()
      const original = fetchMock.getMockImplementation()!
      fetchMock.mockImplementation((url: string, init?: RequestInit) =>
        url === '/api/admin/documents/field-values'
          ? Promise.reject(new Error('boom'))
          : original(url, init),
      )
      render(
        <ChakraProvider>
          <DocumentEditorPage />
        </ChakraProvider>,
      )
      const select = await screen.findByLabelText(/article type/i)
      // The document's own value survives as the sole option; no page error.
      await waitFor(() => expect(select).toHaveValue('Report'))
      expect(screen.queryByText('boom')).not.toBeInTheDocument()
    })
  })

  describe('tag editing', () => {
    const docTag = {
      tagId: 'tag-1',
      facet: 'office',
      valueId: 'WRI India',
      source: 'llm',
      status: 'accepted',
      confidence: 0.9,
    }
    const taxonomy = [
      { id: 'tag-1', facet: 'office', valueId: 'WRI India' },
      { id: 'tag-2', facet: 'office', valueId: 'WRI China' },
      { id: 'tag-3', facet: 'doc_type', valueId: 'Report' },
    ]

    const renderWithTag = () => {
      const fetchMock = setupFetchMock(undefined, [], undefined, {
        tags: [docTag],
        allTags: taxonomy,
      })
      render(
        <ChakraProvider>
          <DocumentEditorPage />
        </ChakraProvider>,
      )
      return fetchMock
    }

    it('renders the tag value as a dropdown of the same facet', async () => {
      renderWithTag()
      const select = (await screen.findByLabelText(
        'office tag',
      )) as HTMLSelectElement
      await waitFor(() =>
        expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
          'WRI India',
          'WRI China',
        ]),
      )
      // doc_type belongs to another facet group and must not leak in.
      expect(
        Array.from(select.options).map((o) => o.textContent),
      ).not.toContain('Report')
    })

    it('adds the new tag before removing the old one when changed', async () => {
      const fetchMock = renderWithTag()
      const select = await screen.findByLabelText('office tag')
      fetchMock.mockClear()
      fireEvent.change(select, { target: { value: 'tag-2' } })

      await waitFor(() => {
        const calls = fetchMock.mock.calls.filter(
          ([url]: any[]) => typeof url === 'string' && url.includes('/tags'),
        )
        expect(calls).toHaveLength(2)
        // Order matters: a failed add must leave the original tag in place.
        expect(calls[0][0]).toBe('/api/admin/documents/test-doc-id-123/tags')
        expect(calls[0][1].method).toBe('POST')
        expect(JSON.parse(calls[0][1].body)).toEqual({ tagId: 'tag-2' })
        expect(calls[1][0]).toBe(
          '/api/admin/documents/test-doc-id-123/tags/tag-1',
        )
        expect(calls[1][1].method).toBe('DELETE')
      })
    })

    it('removes a tag via the Remove button', async () => {
      const fetchMock = renderWithTag()
      const remove = await screen.findByText('Remove')
      fetchMock.mockClear()
      fireEvent.click(remove)

      await waitFor(() => {
        const call = fetchMock.mock.calls.find(
          ([, init]: any[]) => init?.method === 'DELETE',
        )
        expect(call).toBeDefined()
        expect(call![0]).toBe('/api/admin/documents/test-doc-id-123/tags/tag-1')
      })
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

  const historyFixture = {
    total: 2,
    entries: [
      {
        at: new Date().toISOString(),
        action: 'update',
        entityType: 'document',
        actor: 'jane',
        source: 'human',
        before: { title: 'Old' },
        after: { title: 'New' },
      },
      {
        at: new Date().toISOString(),
        action: 'lifecycle',
        entityType: 'document',
        actor: 'jane',
        source: 'human',
        before: { status: 'needs_review' },
        after: { status: 'searchable' },
      },
    ],
  }

  it('does not fetch history until the panel is expanded', async () => {
    const fetchMock = setupFetchMock()
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await screen.findByText('Document editor')
    expect(fetchMock.mock.calls.map(([u]) => String(u))).not.toContainEqual(
      expect.stringContaining('/history'),
    )
  })

  it('fetches and renders one-liners on first expand', async () => {
    setupFetchMock(undefined, [], historyFixture)
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    fireEvent.click(await screen.findByText('History'))
    expect(await screen.findByText(/jane · updated title/)).toBeInTheDocument()
    expect(screen.getByText(/status → searchable/)).toBeInTheDocument()
  })

  it('expands an entry to show before/after values', async () => {
    setupFetchMock(undefined, [], historyFixture)
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    fireEvent.click(await screen.findByText('History'))
    fireEvent.click(await screen.findByText(/jane · updated title/))
    expect(await screen.findByText('Old')).toBeInTheDocument()
    expect(screen.getByText('New')).toBeInTheDocument()
  })

  it('shows Show all when total exceeds the page', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      at: new Date().toISOString(),
      action: 'update',
      entityType: 'document',
      actor: 'jane',
      source: 'human',
      before: { title: `Old ${i}` },
      after: { title: `New ${i}` },
    }))
    setupFetchMock(undefined, [], { total: 25, entries })
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    fireEvent.click(await screen.findByText('History'))
    expect(await screen.findByText('Show all (25)')).toBeInTheDocument()
  })

  it('renders the empty state', async () => {
    setupFetchMock(undefined, [], { total: 0, entries: [] })
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    fireEvent.click(await screen.findByText('History'))
    expect(await screen.findByText('No recorded changes.')).toBeInTheDocument()
  })

  it('resets and refetches history when navigating to another document with the panel open', async () => {
    setupFetchMock(undefined, [], historyFixture)
    const view = render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    fireEvent.click(await screen.findByText('History'))
    expect(await screen.findByText(/jane · updated title/)).toBeInTheDocument()

    // Simulate ReviewBar navigation: the page stays mounted, only [id] changes.
    // Doc B's backend has no history.
    mockParamsId = 'other-doc-id-456'
    const fetchMock2 = setupFetchMock(undefined, [], { total: 0, entries: [] })
    view.rerender(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(
        fetchMock2.mock.calls.some(([u]: any[]) =>
          String(u).includes('/api/admin/documents/other-doc-id-456/history'),
        ),
      ).toBe(true)
    })
    // Doc A's entries are gone; doc B's (empty) history renders.
    expect(await screen.findByText('No recorded changes.')).toBeInTheDocument()
    expect(screen.queryByText(/jane · updated title/)).not.toBeInTheDocument()
  })

  it('marks the Save button dirty after an edit and clears it after save', async () => {
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Authors')).toBeInTheDocument())

    // Save starts clean.
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()

    // Edit the URL field → dirty.
    const url = screen.getByDisplayValue('https://example.com/test')
    fireEvent.change(url, { target: { value: 'https://example.com/edited' } })
    expect(
      screen.getByRole('button', { name: 'Save (unsaved changes)' }),
    ).toBeInTheDocument()

    // Save → load({resetForm:true}) clears dirty.
    fireEvent.click(
      screen.getByRole('button', { name: 'Save (unsaved changes)' }),
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument(),
    )
  })

  it('registers a beforeunload handler only while dirty', async () => {
    const addSpy = jest.spyOn(window, 'addEventListener')
    render(
      <ChakraProvider>
        <DocumentEditorPage />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Authors')).toBeInTheDocument())

    expect(addSpy.mock.calls.some(([e]) => e === 'beforeunload')).toBe(false)

    fireEvent.change(screen.getByDisplayValue('https://example.com/test'), {
      target: { value: 'https://example.com/edited' },
    })
    expect(addSpy.mock.calls.some(([e]) => e === 'beforeunload')).toBe(true)
    addSpy.mockRestore()
  })
})
