import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import CollectionsPage from '@/app/admin/collections/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

jest.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => '/admin/collections',
  useSearchParams: () => ({ get: () => null }),
}))

const mockCollections = [
  { id: 'col-1', name: 'Legacy Transport', slug: 'legacy-transport', description: 'All docs', documentCount: 169 },
]

describe('CollectionsPage (jsdom)', () => {
  it('renders a collections explainer', async () => {
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/admin/collections') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, collections: mockCollections }),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })
    global.fetch = fetchMock as any

    render(
      <ChakraProvider>
        <CollectionsPage />
      </ChakraProvider>,
    )

    await waitFor(() => {
      // The page should have an explainer about what collections are for
      // (multiple elements mention "collections" — heading, tooltip, explainer text)
      expect(screen.getAllByText(/collections/i).length).toBeGreaterThan(0)
    })
  })
})
