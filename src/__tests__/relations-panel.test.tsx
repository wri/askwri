import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import RelationsPanel from '@/app/admin/components/RelationsPanel'
import ChakraProvider from '@/app/Providers/ChakraProvider'

jest.mock('next/navigation', () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => '/admin/review',
  useSearchParams: () => ({ get: () => null }),
}))

const suggestedRow = {
  id: 'rel-1',
  documentId: 'doc-t',
  relatedDocumentId: 'doc-o',
  relationType: 'translation_of',
  status: 'suggested',
  source: 'system',
  confidence: 0.98,
  signals: {
    title_similarity: 0.98,
    embedding_similarity: 0.72,
    language_disagreement: [{ external_id: 'x', stamped: 'zh', detected: 'en' }],
  },
  createdAt: '2026-01-01T00:00:00Z',
  reviewedBy: null,
  reviewedAt: null,
  translation: {
    externalId: '2021_seizing_9025',
    title: "Seizing China's Urban Opportunity",
    language: 'en',
  },
  original: {
    externalId: '2021_seizing_00015',
    title: '抓住中国城市机遇',
    language: 'zh',
  },
}

const confirmedRow = {
  id: 'rel-2',
  documentId: 'doc-t2',
  relatedDocumentId: 'doc-o2',
  relationType: 'translation_of',
  status: 'confirmed',
  source: 'human',
  confidence: null,
  signals: {},
  createdAt: '2026-01-02T00:00:00Z',
  reviewedBy: 'tester',
  reviewedAt: '2026-01-02T00:00:00Z',
  translation: { externalId: 'other_en', title: 'Other English', language: 'en' },
  original: { externalId: 'other_es', title: 'Otro Original', language: 'es' },
}

// Returns a fetch mock that serves the two relation lists + captures PATCHes.
function setupFetchMock() {
  const fetchMock = jest.fn((url: string, init?: any) => {
    const base = url.split('?')[0]
    if (base === '/api/admin/relations' && init?.method === 'PATCH') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, relation: { id: 'rel-1' } }),
      })
    }
    if (url.startsWith('/api/admin/relations?status=suggested')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, relations: [suggestedRow] }),
      })
    }
    if (url.startsWith('/api/admin/relations?status=confirmed')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, relations: [confirmedRow] }),
      })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
  })
  global.fetch = fetchMock as any
  return fetchMock
}

const renderPanel = (props?: { docId?: string }) =>
  render(
    <ChakraProvider>
      <RelationsPanel {...props} />
    </ChakraProvider>,
  )

const ORPHAN_NOTE =
  'Withdrawing this document also removes its linked translation from results (the pair is one work).'

describe('RelationsPanel (jsdom)', () => {
  it('renders a suggestion row with both titles, languages, and signal chips', async () => {
    setupFetchMock()
    renderPanel({ docId: 'doc-t' })

    await waitFor(() => {
      expect(screen.getByText("Seizing China's Urban Opportunity")).toBeInTheDocument()
    })
    expect(screen.getByText('抓住中国城市机遇')).toBeInTheDocument()
    expect(screen.getByText('[zh]')).toBeInTheDocument()
    expect(screen.getByText('[en]')).toBeInTheDocument()
    expect(screen.getByText(/title 0\.98/)).toBeInTheDocument()
    expect(screen.getByText(/embed 0\.72/)).toBeInTheDocument()
    expect(screen.getByText(/language mismatch/)).toBeInTheDocument()
  })

  it('clicking Confirm PATCHes {action:"confirm"}', async () => {
    const fetchMock = setupFetchMock()
    renderPanel()

    const confirm = await screen.findByRole('button', { name: 'Confirm pair' })
    fireEvent.click(confirm)

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => c[0] === '/api/admin/relations/rel-1' && c[1]?.method === 'PATCH',
      )
      expect(patch).toBeTruthy()
      expect(patch![1].body).toBe(JSON.stringify({ action: 'confirm' }))
    })
  })

  it('clicking "Not a pair" PATCHes {action:"reject"}', async () => {
    const fetchMock = setupFetchMock()
    renderPanel()

    const reject = await screen.findByRole('button', { name: 'Not a pair' })
    fireEvent.click(reject)

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => c[0] === '/api/admin/relations/rel-1' && c[1]?.method === 'PATCH',
      )
      expect(patch).toBeTruthy()
      expect(patch![1].body).toBe(JSON.stringify({ action: 'reject' }))
    })
  })

  it('clicking the direction arrow PATCHes {action:"flip"}', async () => {
    const fetchMock = setupFetchMock()
    renderPanel()

    const flip = await screen.findByRole('button', { name: 'Flip direction' })
    fireEvent.click(flip)

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => c[0] === '/api/admin/relations/rel-1' && c[1]?.method === 'PATCH',
      )
      expect(patch).toBeTruthy()
      expect(patch![1].body).toBe(JSON.stringify({ action: 'flip' }))
    })
  })

  it('confirmed row shows Unlink', async () => {
    setupFetchMock()
    renderPanel()

    expect(await screen.findByRole('button', { name: 'Unlink' })).toBeInTheDocument()
  })

  it('orphan warning renders for originals with a confirmed edge', async () => {
    setupFetchMock()
    renderPanel({ docId: 'doc-o2' }) // doc-o2 is the original of confirmedRow

    await waitFor(() => {
      expect(screen.getByText(ORPHAN_NOTE)).toBeInTheDocument()
    })
  })

  it('orphan warning does not render when the doc is the translation', async () => {
    setupFetchMock()
    renderPanel({ docId: 'doc-t2' }) // doc-t2 is the translation of confirmedRow

    await waitFor(() => {
      expect(screen.queryByText(ORPHAN_NOTE)).not.toBeInTheDocument()
    })
  })
})
