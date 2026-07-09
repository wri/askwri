import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import CatalogPage from '@/app/admin/documents/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

jest.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => null }),
}))

const doc = {
  id: 'd1',
  externalId: 'ext-1',
  title: 'Doc One',
  language: 'en',
  status: 'searchable',
  yearPublished: 2024,
}

function setupFetchMock() {
  const fetchMock = jest.fn((url: string) => {
    if (url.startsWith('/api/admin/collections')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, collections: [] }),
      } as any)
    }
    if (url.startsWith('/api/admin/tags')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, tags: [] }),
      } as any)
    }
    // /api/admin/documents (list + years backfill)
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ items: [doc], total: 1 }),
    } as any)
  })
  global.fetch = fetchMock as any
  return fetchMock
}

describe('CatalogPage', () => {
  afterEach(() => jest.useRealTimers())

  it('shows a loading line before documents resolve', () => {
    setupFetchMock()
    render(
      <ChakraProvider>
        <CatalogPage />
      </ChakraProvider>,
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('debounces rapid search keystrokes into a single request', async () => {
    const fetchMock = setupFetchMock()
    render(
      <ChakraProvider>
        <CatalogPage />
      </ChakraProvider>,
    )
    await waitFor(() => expect(screen.getByText('Doc One')).toBeInTheDocument())

    jest.useFakeTimers()
    const input = screen.getByPlaceholderText(/Search title/i)
    const countSearchCalls = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).includes('search=cli'))
        .length

    fireEvent.change(input, { target: { value: 'c' } })
    fireEvent.change(input, { target: { value: 'cl' } })
    fireEvent.change(input, { target: { value: 'cli' } })
    // Within the debounce window: no request fired yet.
    expect(countSearchCalls()).toBe(0)

    act(() => {
      jest.advanceTimersByTime(300)
    })
    expect(countSearchCalls()).toBe(1)
  })
})
