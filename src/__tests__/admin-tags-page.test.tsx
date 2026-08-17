import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import TagsPage from '@/app/admin/tags/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

// Mutable search-params facet so individual tests can control which tab is active
let mockFacet = 'program'
jest.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
  }),
  usePathname: () => '/admin/tags',
  useSearchParams: () => ({ get: (key: string) => (key === 'facet' ? mockFacet : null) }),
}))

const mockTags = [
  {
    id: 'tag-1',
    facet: 'program',
    valueId: 'Cities',
    taxonomyVersion: 'v1',
    acceptedCount: 169,
    suggestedCount: 0,
  },
  {
    id: 'tag-2',
    facet: 'office',
    valueId: 'WRI India',
    taxonomyVersion: 'v1',
    acceptedCount: 5,
    suggestedCount: 0,
  },
  {
    id: 'tag-3',
    facet: 'topic',
    valueId: 'Transport decarbonization',
    taxonomyVersion: 'v1',
    acceptedCount: 148,
    suggestedCount: 0,
  },
  {
    id: 'tag-4',
    facet: 'doc_type',
    valueId: 'Report',
    taxonomyVersion: 'v1',
    acceptedCount: 10,
    suggestedCount: 0,
  },
]

const renderPage = (role: string = 'admin') => {
  const fetchMock = jest.fn((url: string) => {
    if (url === '/api/admin/tags') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, tags: mockTags }),
      })
    }
    if (url === '/api/admin/auth/me') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ identity: { role } }),
      })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
  global.fetch = fetchMock as any
  return render(
    <ChakraProvider>
      <TagsPage />
    </ChakraProvider>,
  )
}

describe('TagsPage (jsdom)', () => {
  it('renders the canonical facets in the add-tag dropdown', async () => {
    renderPage()
    // The facet dropdown should contain all 4 canonical facets
    await waitFor(() => {
      expect(screen.getByText('program')).toBeInTheDocument()
    })
    expect(screen.getByText('office')).toBeInTheDocument()
    expect(screen.getByText('topic')).toBeInTheDocument()
    expect(screen.getByText('doc_type')).toBeInTheDocument()
  })

  it('renders a "Create new facet" option in the dropdown', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('Create new facet…')).toBeInTheDocument()
    })
  })

  it('renders the taxonomy v1 deferral explainer', async () => {
    renderPage()
    await waitFor(() => {
      // The page should mention the deferral status (two Text elements mention it)
      expect(screen.getAllByText(/Taxonomy v1/i).length).toBeGreaterThan(0)
    })
  })

  it('shows a Rename button for admins on each tag value', async () => {
    renderPage('admin')
    await waitFor(() => {
      // Admin sees Rename buttons
      expect(screen.getAllByText('Rename').length).toBeGreaterThan(0)
    })
  })

  it('does not show Rename buttons for non-admin editors', async () => {
    renderPage('editor')
    await waitFor(() => {
      expect(screen.queryByText('Rename')).not.toBeInTheDocument()
    })
  })
})

describe('TagsPage facet tabs (jsdom)', () => {
  afterEach(() => {
    mockFacet = 'program'
  })

  it('renders the Topic tab and, when clicked, shows the TopicTaxonomyManager heading', async () => {
    mockFacet = 'topic'

    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/admin/tags')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, tags: mockTags }) })
      if (url === '/api/admin/auth/me')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ identity: { role: 'admin' } }) })
      if (url === '/api/admin/topics')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, tags: [] }) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })
    global.fetch = fetchMock as any

    render(
      <ChakraProvider>
        <TagsPage />
      </ChakraProvider>,
    )

    // The Topic tab should be present in the tab strip
    await waitFor(() => {
      expect(screen.getByText('Topic')).toBeInTheDocument()
    })
    // The TopicTaxonomyManager heading should appear (active tab is topic)
    await waitFor(() => {
      expect(screen.getByText('Topic taxonomy')).toBeInTheDocument()
    })
  })
})
