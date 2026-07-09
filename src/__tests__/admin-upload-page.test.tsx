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
