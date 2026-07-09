import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import UploadPage from '@/app/admin/upload/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

jest.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
  }),
  usePathname: () => '/admin/upload',
  useSearchParams: () => ({ get: () => null }),
}))

// Mirrors the page's poll interval. Deliberately hard-coded — do not import
// the page's private constant; keep the test decoupled.
const POLL_INTERVAL_MS_TEST = 5000

const healthOk = {
  ok: true,
  json: () =>
    Promise.resolve({
      ok: true,
      health: {
        queueDepth: 0,
        lastProcessedAt: null,
        intakeBacklog: 0,
        status: 'idle',
      },
    }),
}

// Build a File whose .name ends in .pdf (contents irrelevant — server validates,
// which we mock).
const pdf = (name: string) =>
  new File(['%PDF-1.4'], name, { type: 'application/pdf' })

const renderPage = () =>
  render(
    <ChakraProvider>
      <UploadPage />
    </ChakraProvider>,
  )

afterEach(() => {
  jest.restoreAllMocks()
})

describe('UploadPage — dropzone + per-file results', () => {
  it('drops PDFs, uploads them, and lists each accepted file', async () => {
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/admin/worker-health') return Promise.resolve(healthOk)
      if (url === '/api/admin/intake') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ ok: true, uploaded: ['a.pdf', 'b.pdf'] }),
        })
      }
      // documents poll — nothing registered yet
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, items: [], total: 0 }),
      })
    })
    global.fetch = fetchMock as any
    renderPage()

    const zone = screen.getByLabelText(
      'Drop PDFs here or click to choose files',
    )
    await act(async () => {
      fireEvent.drop(zone, {
        dataTransfer: { files: [pdf('a.pdf'), pdf('b.pdf')] },
      })
    })

    await screen.findByText('a.pdf')
    expect(screen.getByText('b.pdf')).toBeInTheDocument()
    // POST body was multipart FormData, not JSON
    const post = fetchMock.mock.calls.find((c) => c[0] === '/api/admin/intake')!
    expect(post[1].body).toBeInstanceOf(FormData)
  })

  it('rejects non-PDF drops with a message and does not upload them', async () => {
    const fetchMock = jest.fn((url: string) =>
      url === '/api/admin/worker-health'
        ? Promise.resolve(healthOk)
        : Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ok: true, items: [] }),
          }),
    )
    global.fetch = fetchMock as any
    renderPage()

    const zone = screen.getByLabelText(
      'Drop PDFs here or click to choose files',
    )
    await act(async () => {
      fireEvent.drop(zone, {
        dataTransfer: {
          files: [new File(['x'], 'notes.txt', { type: 'text/plain' })],
        },
      })
    })

    await screen.findByText(/Skipped non-PDF/i)
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/admin/intake',
      expect.anything(),
    )
  })

  it('renders the batch-400 error and leaves the session list untouched', async () => {
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/admin/worker-health') return Promise.resolve(healthOk)
      if (url === '/api/admin/intake') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () =>
            Promise.resolve({
              ok: false,
              error: 'big.pdf: file too large (max 52428800 bytes)',
            }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, items: [] }),
      })
    })
    global.fetch = fetchMock as any
    renderPage()

    const zone = screen.getByLabelText(
      'Drop PDFs here or click to choose files',
    )
    await act(async () => {
      fireEvent.drop(zone, {
        dataTransfer: { files: [pdf('ok.pdf'), pdf('big.pdf')] },
      })
    })

    await screen.findByText(/big\.pdf: file too large/i)
    // ALL-OR-NOTHING: nothing was accepted, so no filename appears in a list row
    expect(screen.queryByText('ok.pdf')).not.toBeInTheDocument()
    expect(screen.queryByText('big.pdf')).not.toBeInTheDocument()
  })
})

describe('UploadPage — polling + likely-duplicate', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const dropOne = async (name: string) => {
    const zone = screen.getByLabelText(
      'Drop PDFs here or click to choose files',
    )
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [pdf(name)] } })
    })
  }

  it('flips an entry to its StatusChip + editor link when the doc registers', async () => {
    let registered = false
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/admin/worker-health') return Promise.resolve(healthOk)
      if (url === '/api/admin/intake')
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, uploaded: ['doc.pdf'] }),
        })
      // documents poll
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            items: registered
              ? [
                  {
                    id: 'doc-id-1',
                    externalId: 'doc',
                    title: 'Doc',
                    language: 'en',
                    status: 'processing',
                  },
                ]
              : [],
            total: registered ? 1 : 0,
          }),
      })
    })
    global.fetch = fetchMock as any
    renderPage()
    await dropOne('doc.pdf')
    expect(screen.getByText('doc.pdf')).toBeInTheDocument()

    registered = true
    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS_TEST)
    })

    expect(screen.getByText('processing')).toBeInTheDocument() // StatusChip
    expect(screen.getByRole('link', { name: /open/i })).toHaveAttribute(
      'href',
      '/admin/documents/doc-id-1',
    )
  })

  it('does NOT exact-match on an ILIKE substring near-miss', async () => {
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/admin/worker-health') return Promise.resolve(healthOk)
      if (url === '/api/admin/intake')
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, uploaded: ['doc.pdf'] }),
        })
      // search=doc returns a substring near-miss "doc-2023", not our stem
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            items: [
              {
                id: 'x',
                externalId: 'doc-2023',
                title: 'X',
                language: 'en',
                status: 'searchable',
              },
            ],
          }),
      })
    })
    global.fetch = fetchMock as any
    renderPage()
    await dropOne('doc.pdf')
    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS_TEST)
    })
    expect(screen.queryByText('searchable')).not.toBeInTheDocument()
    expect(screen.getByText(/waiting to register/i)).toBeInTheDocument()
  })

  it('infers "likely duplicate" only after 90s with zero backlog', async () => {
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/admin/worker-health') return Promise.resolve(healthOk) // backlog 0
      if (url === '/api/admin/intake')
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, uploaded: ['dup.pdf'] }),
        })
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, items: [] }),
      })
    })
    global.fetch = fetchMock as any
    renderPage()
    await dropOne('dup.pdf')

    // At 60s: not yet flagged.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60000)
    })
    expect(screen.queryByText(/likely duplicate/i)).not.toBeInTheDocument()

    // Past 90s: flagged, and polling stops (interval cleared).
    await act(async () => {
      await jest.advanceTimersByTimeAsync(40000)
    })
    expect(screen.getByText(/likely duplicate/i)).toBeInTheDocument()

    // All entries are terminal now — advancing further must trigger NO
    // additional fetches (the shared interval is actually cleared).
    const callsAtTerminal = fetchMock.mock.calls.length
    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS_TEST * 4)
    })
    expect(fetchMock.mock.calls.length).toBe(callsAtTerminal)
  })
})
