import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import DocumentEditorPage from '@/app/admin/documents/[id]/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

// Mock next/navigation (useParams)
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'test-doc-id-123' }),
  useRouter: () => ({
    push: jest.fn(),
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
    { language: 'en', kind: 'long', text: 'A long English summary.', source: 'external' },
    { language: 'en', kind: 'short', text: 'A short summary.', source: 'external' },
  ],
  tags: [],
  collections: [],
  latestJob: null,
}

function setupFetchMock() {
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    // adminFetch calls fetch with the path directly; auth/me uses raw fetch
    if (url === '/api/admin/auth/me') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ identity: { username: 'admin', role: 'admin' } }),
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
        json: () => Promise.resolve(mockDetail),
      } as any)
    }
    // Default: empty ok response
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as any)
  })
  global.fetch = fetchMock as any
  return fetchMock
}

describe('DocumentEditorPage', () => {
  beforeEach(() => {
    setupFetchMock()
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
      expect(screen.getByText(/Source metadata/i)).toBeInTheDocument()
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
      const summaryTextareas = document.querySelectorAll('textarea[data-summary-key]')
      expect(summaryTextareas.length).toBeGreaterThan(0)
    })
  })
})
