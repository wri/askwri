import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ImportPage from '@/app/admin/import/page'
import ChakraProvider from '@/app/Providers/ChakraProvider'

// Mock next/navigation
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
  }),
  usePathname: () => '/admin/import',
  useSearchParams: () => ({ get: () => null }),
}))

// The CSV the page parses client-side: file_path, metadata (JSON string), summary
const SAMPLE_CSV = `file_path,metadata,summary
test-doc-one.pdf,"{""Article Title"":""Doc One"",""YEAR published"":""2024""}","A summary for doc one"
test-doc-two.pdf,"{""Article Title"":""Doc Two"",""YEAR published"":""2023""}","A summary for doc two"`

function setupFetchMock() {
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    if (url === '/api/admin/auth/me') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ identity: { username: 'admin', role: 'admin' } }),
      } as any)
    }
    if (url === '/api/import-documents') {
      const body = JSON.parse(init?.body as string)
      if (body.dryRun) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              created: 1,
              updated: 0,
              skipped: 1,
              jobs: 0,
              decisions: [
                { externalId: 'test-doc-one', action: 'created' },
                {
                  externalId: 'test-doc-two',
                  action: 'skipped',
                  reason: 'already exists',
                },
              ],
            }),
        } as any)
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            created: 1,
            updated: 0,
            skipped: 1,
            jobs: 1,
            decisions: undefined,
          }),
      } as any)
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as any)
  })
  global.fetch = fetchMock as any
  return fetchMock
}

function makeFile(content: string, name = 'documents.csv') {
  return new File([content], name, { type: 'text/csv' })
}

/** Helper: load a CSV file into the page and wait for it to parse. */
async function loadCsv(csv: string) {
  const input = screen.getByLabelText(/csv file/i) as HTMLInputElement
  fireEvent.change(input, { target: { files: [makeFile(csv)] } })
  fireEvent.click(screen.getByRole('button', { name: 'Load CSV' }))
  await waitFor(() => {
    expect(screen.getByText(/row\(s\) parsed/i)).toBeInTheDocument()
  })
}

describe('ImportPage', () => {
  beforeEach(() => {
    setupFetchMock()
  })

  it('renders a file input, a Preview button, and an Apply button', async () => {
    render(
      <ChakraProvider>
        <ImportPage />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText(/Import metadata from CSV/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(screen.getByLabelText(/csv file/i)).toBeInTheDocument()
  })

  it('shows a dry-run decisions table after Preview', async () => {
    render(
      <ChakraProvider>
        <ImportPage />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Preview' }),
      ).toBeInTheDocument()
    })

    await loadCsv(SAMPLE_CSV)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    await waitFor(() => {
      expect(screen.getByText('test-doc-one')).toBeInTheDocument()
      expect(screen.getByText('test-doc-two')).toBeInTheDocument()
    })
    expect(screen.getByText('created')).toBeInTheDocument()
    expect(screen.getByText('skipped')).toBeInTheDocument()
  })

  it('Apply button POSTs without dryRun and shows result counts', async () => {
    const fetchMock = global.fetch as any
    render(
      <ChakraProvider>
        <ImportPage />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
    })

    await loadCsv(SAMPLE_CSV)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => {
      expect(screen.getByText('test-doc-one')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      // The result summary should show the counts
      expect(screen.getByText(/Created: 1/)).toBeInTheDocument()
      expect(screen.getByText(/Skipped: 1/)).toBeInTheDocument()
      expect(screen.getByText(/Jobs queued: 1/)).toBeInTheDocument()
    })
    // Verify an apply call (no dryRun) was made
    const importCalls = fetchMock.mock.calls.filter(
      (c: any[]) => c[0] === '/api/import-documents',
    )
    const applyCall = importCalls.find((c: any[]) => {
      const body = JSON.parse(c[1]?.body as string)
      return !body.dryRun
    })
    expect(applyCall).toBeDefined()
  })

  it('redirects to login on 401', async () => {
    const originalLocation = window.location
    delete (window as any).location
    ;(window as any).location = { href: '' }

    global.fetch = jest.fn((url: string) => {
      if (url === '/api/import-documents') {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({}),
        } as any)
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ identity: { username: 'admin', role: 'admin' } }),
      } as any)
    }) as any

    render(
      <ChakraProvider>
        <ImportPage />
      </ChakraProvider>,
    )
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Preview' }),
      ).toBeInTheDocument()
    })

    await loadCsv(SAMPLE_CSV)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    await waitFor(() => {
      expect((window as any).location.href).toContain('/admin/login')
    })
    ;(window as any).location = originalLocation
  })
})
