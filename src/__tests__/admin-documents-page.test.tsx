import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import CatalogPage from '@/app/admin/documents/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

let mockParams = new URLSearchParams('')
const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockParams,
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  usePathname: () => '/admin/documents',
}))

const docs = [
  {
    id: 'd1',
    externalId: 'ext-1',
    title: 'Alpha',
    language: 'en',
    status: 'searchable',
    yearPublished: 2021,
  },
  {
    id: 'd2',
    externalId: 'ext-2',
    title: 'Beta',
    language: 'es',
    status: 'needs_review',
    yearPublished: 2020,
  },
]

// Capture every documents-list URL adminFetch requests so we can assert the query string.
let listUrls: string[] = []
const setupFetch = () => {
  listUrls = []
  global.fetch = jest.fn((url: string) => {
    if (url.startsWith('/api/admin/documents')) {
      if (!url.includes('limit=500')) listUrls.push(url) // ignore the loadYears() sweep
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, items: docs, total: 2 }),
      })
    }
    if (url.startsWith('/api/admin/collections'))
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, collections: [] }),
      })
    if (url.startsWith('/api/admin/tags'))
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, tags: [] }),
      })
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    })
  }) as any
}

const renderPage = () =>
  render(
    <ChakraProvider>
      <CatalogPage />
    </ChakraProvider>,
  )

beforeEach(() => {
  mockParams = new URLSearchParams('')
  mockReplace.mockClear()
  setupFetch()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('CatalogPage — URL-driven view state (jsdom)', () => {
  it('shows a loading line before documents resolve', () => {
    renderPage()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('applies filters from the URL to the list request', async () => {
    mockParams = new URLSearchParams('status=searchable&language=es')
    renderPage()
    await screen.findByText('Alpha')
    const listCall = listUrls.find((u) => u.includes('status=searchable'))
    expect(listCall).toBeDefined()
    expect(listCall).toContain('language=es')
  })

  it('applies sort + dir from the URL and marks the active header with aria-sort', async () => {
    mockParams = new URLSearchParams('sort=year_published&dir=asc')
    renderPage()
    await screen.findByText('Alpha')
    expect(
      listUrls.some(
        (u) => u.includes('sort=year_published') && u.includes('dir=asc'),
      ),
    ).toBe(true)
    const yearHeader = screen.getByRole('columnheader', { name: /Year/ })
    expect(yearHeader).toHaveAttribute('aria-sort', 'ascending')
  })

  it('writes a filter change to the URL via router.replace (not push), resetting page', async () => {
    renderPage()
    await screen.findByText('Alpha')
    // The filter selects have NO accessible name (no label/aria-label), so
    // getByRole('combobox', { name }) will not match — select by displayed option.
    fireEvent.change(screen.getByDisplayValue('All statuses'), {
      target: { value: 'needs_review' },
    })
    await waitFor(() => expect(mockReplace).toHaveBeenCalled())
    const target = mockReplace.mock.calls.at(-1)![0] as string
    expect(target).toContain('status=needs_review')
    expect(target).not.toContain('page=') // reset to default page 0 (omitted)
  })

  it('cycles a sortable header asc → desc → default through the URL', async () => {
    // The mocked useSearchParams reads module-level mockParams at render time,
    // so after each reassignment we MUST rerender — otherwise the click handler
    // sees stale params and the asc→desc→default assertions fail even against
    // correct code.
    const { rerender } = renderPage()
    const rerenderPage = () =>
      rerender(
        <ChakraProvider>
          <CatalogPage />
        </ChakraProvider>,
      )
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByRole('button', { name: /^Title/ })) // 1st click → asc
    expect(mockReplace.mock.calls.at(-1)![0]).toMatch(
      /sort=title.*dir=asc|dir=asc.*sort=title/,
    )

    mockParams = new URLSearchParams('sort=title&dir=asc') // simulate URL settled
    rerenderPage()
    // Re-query after rerender; label now includes the ▲ glyph, /^Title/ still matches.
    fireEvent.click(screen.getByRole('button', { name: /^Title/ })) // 2nd click → desc
    expect(mockReplace.mock.calls.at(-1)![0]).toContain('dir=desc')

    mockParams = new URLSearchParams('sort=title&dir=desc')
    rerenderPage()
    fireEvent.click(screen.getByRole('button', { name: /^Title/ })) // 3rd click → default (no sort/dir)
    const cleared = mockReplace.mock.calls.at(-1)![0] as string
    expect(cleared).not.toContain('sort=')
    expect(cleared).not.toContain('dir=')
  })

  it('preserves an inbound ?collectionId= deep link in the list request', async () => {
    mockParams = new URLSearchParams('collectionId=abc-123')
    renderPage()
    await screen.findByText('Alpha')
    expect(listUrls.some((u) => u.includes('collectionId=abc-123'))).toBe(true)
  })

  it('seeds the search input from the URL and carries it in the list request', async () => {
    mockParams = new URLSearchParams('search=foo')
    renderPage()
    await screen.findByText('Alpha')
    expect(screen.getByPlaceholderText(/Search title/i)).toHaveValue('foo')
    expect(listUrls.some((u) => u.includes('search=foo'))).toBe(true)
  })

  it('debounces rapid search keystrokes into a single URL write, resetting page', async () => {
    renderPage()
    await screen.findByText('Alpha')

    jest.useFakeTimers()
    const input = screen.getByPlaceholderText(/Search title/i)
    fireEvent.change(input, { target: { value: 'c' } })
    fireEvent.change(input, { target: { value: 'cl' } })
    fireEvent.change(input, { target: { value: 'cli' } })
    // Within the debounce window: nothing committed yet.
    expect(mockReplace).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(300)
    })
    // One settled write for the whole burst.
    expect(mockReplace).toHaveBeenCalledTimes(1)
    const target = mockReplace.mock.calls.at(-1)![0] as string
    expect(target).toContain('search=cli')
    expect(target).not.toContain('page=')
  })

  it('clears a pending search debounce on a URL-driven reload (no stale overwrite)', async () => {
    const { rerender } = renderPage()
    await screen.findByText('Alpha')

    jest.useFakeTimers()
    fireEvent.change(screen.getByPlaceholderText(/Search title/i), {
      target: { value: 'zzz' },
    })
    // External URL change (e.g. back/forward) lands before the debounce settles.
    mockParams = new URLSearchParams('status=searchable')
    rerender(
      <ChakraProvider>
        <CatalogPage />
      </ChakraProvider>,
    )
    act(() => {
      jest.advanceTimersByTime(400)
    })
    // The URL-keyed load effect must have cleared the pending timer — otherwise
    // it fires ~300ms after the reset and writes the stale search to the URL.
    expect(
      mockReplace.mock.calls.some((c) => (c[0] as string).includes('zzz')),
    ).toBe(false)
  })

  it('clears the bulk selection when the view changes', async () => {
    renderPage()
    await screen.findByText('Alpha')
    fireEvent.click(screen.getAllByRole('checkbox')[1]) // first row checkbox
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
    fireEvent.change(screen.getByDisplayValue('All statuses'), {
      target: { value: 'needs_review' },
    })
    await waitFor(() =>
      expect(screen.queryByText('1 selected')).not.toBeInTheDocument(),
    )
  })
})
