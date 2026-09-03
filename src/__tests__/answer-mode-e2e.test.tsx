import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import ChakraProvider from '@/app/Providers/ChakraProvider'
import { AIResearchModal } from '@/app/components/AnswerMode/AIResearchModal'

jest.mock('@/lib/catalog-cache', () => ({
  getCatalog: jest.fn().mockResolvedValue({ catalog: [], index: null }),
}))

const jsonResponse = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
})

describe('answer mode end-to-end UI flow', () => {
  const fetchMock = jest.fn()

  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: jest.fn(),
    })
  })

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock
  })

  it('shows limited coverage when retrieval says an off-topic query has no usable docs', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        docs: [],
        usage: null,
        debug: {},
        likely_off_topic: true,
      }),
    )

    render(
      <ChakraProvider>
        <AIResearchModal open />
      </ChakraProvider>,
    )

    fireEvent.change(screen.getByLabelText('Search query input'), {
      target: { value: 'A question outside the corpus' },
    })
    fireEvent.click(screen.getByLabelText('Submit search query'))

    expect(
      await screen.findByText(
        'Unable to synthesize answer: no documents with content found.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Limited coverage')).toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('retrieves, synthesizes, and renders a model-emitted citation with exact request payloads', async () => {
    const query = 'How do cities cut emissions?'
    const doc = {
      doc_id: 'doc-1',
      ref: 'doc-1',
      title: 'Urban Climate Action',
      year: 2025,
      kps: [
        {
          kp_relevance: 0.9,
          snippet:
            'Compact growth and transit investments can reduce emissions.',
          passage_id: 'passage-7',
          page: 4,
          citation_targets: [],
        },
      ],
    }

    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/llamaindex') {
        return jsonResponse({
          docs: [doc],
          usage: null,
          debug: {},
          likely_off_topic: false,
        })
      }
      if (url === '/api/answer') {
        return jsonResponse({
          ok: true,
          synthesis: {
            sentences: ['Compact growth can reduce urban emissions.'],
            cites: [[1]],
          },
          passages_sent: [
            {
              id: 1,
              doc_id: 'doc-1',
              chunk_id: 'passage-7',
              page: 4,
              text: doc.kps[0].snippet,
            },
          ],
        })
      }
      if (url === '/api/alignment') {
        return jsonResponse({ ok: false })
      }
      if (url === '/api/answer-mode-query-logs') {
        return jsonResponse({ ok: true })
      }
      if (url === '/api/batch-why') {
        return jsonResponse({ ok: true, explanations: [] })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    render(
      <ChakraProvider>
        <AIResearchModal open />
      </ChakraProvider>,
    )

    fireEvent.change(screen.getByLabelText('Search query input'), {
      target: { value: query },
    })
    fireEvent.click(screen.getByLabelText('Submit search query'))

    expect(
      await screen.findByText('Compact growth can reduce urban emissions.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Based on 1 Knowledge Product:'),
    ).toBeInTheDocument()
    expect(screen.getByTitle('Citation 1.1')).toBeInTheDocument()

    const gatewayCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/llamaindex',
    )
    const answerCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/answer',
    )
    expect(gatewayCall?.[1]?.body).toBe(
      JSON.stringify({
        query,
        mode: 'answer',
        include_metadata: true,
      }),
    )
    expect(answerCall?.[1]?.body).toBe(
      JSON.stringify({
        query,
        docs: [doc],
        likely_off_topic: false,
      }),
    )
  })
})
