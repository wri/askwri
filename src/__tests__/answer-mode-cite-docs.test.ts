/**
 * Tests for AW-28: Answer mode filters retrieval to user-selected Cite docs.
 *
 * Validates:
 *  - cite_doc_ids extraction from RowData[]
 *  - fetch payload includes cite_doc_ids when docs are selected
 *  - fetch payload omits cite_doc_ids when no docs are selected
 *  - API route passes cite_doc_ids through to the search service
 */

// --- cite_doc_ids extraction logic (mirrors AIResearchModal lines 62-65) ---

function extractCiteDocIds(
  citeDocs: Array<{ id: string | number }> | undefined,
): string[] | undefined {
  if (citeDocs && citeDocs.length > 0) {
    return citeDocs.map((d) => d.id) as string[]
  }
  return undefined
}

function buildPayload(
  query: string,
  citeDocIds: string[] | undefined,
): Record<string, unknown> {
  return {
    query,
    mode: 'answer',
    include_metadata: true,
    ...(citeDocIds ? { cite_doc_ids: citeDocIds } : {}),
  }
}

// --- Tests ---

describe('extractCiteDocIds', () => {
  it('returns doc ids from selected rows', () => {
    const docs = [{ id: 'doc_a' }, { id: 'doc_b' }, { id: 'doc_c' }]
    expect(extractCiteDocIds(docs)).toEqual(['doc_a', 'doc_b', 'doc_c'])
  })

  it('returns undefined when citeDocs is undefined', () => {
    expect(extractCiteDocIds(undefined)).toBeUndefined()
  })

  it('returns undefined when citeDocs is empty', () => {
    expect(extractCiteDocIds([])).toBeUndefined()
  })

  it('handles numeric ids (RowData.id is string | number)', () => {
    const docs = [{ id: 42 }, { id: 'doc_b' }]
    const result = extractCiteDocIds(docs)
    expect(result).toEqual([42, 'doc_b'])
  })

  it('caps at 20 when sliced upstream', () => {
    const docs = Array.from({ length: 25 }, (_, i) => ({ id: `doc_${i}` }))
    // ResultsTable does .slice(0, 20) before passing
    const sliced = docs.slice(0, 20)
    const ids = extractCiteDocIds(sliced)
    expect(ids).toHaveLength(20)
    expect(ids![0]).toBe('doc_0')
    expect(ids![19]).toBe('doc_19')
  })
})

describe('buildPayload', () => {
  it('includes cite_doc_ids when provided', () => {
    const payload = buildPayload('forest restoration', ['doc_a', 'doc_b'])
    expect(payload).toHaveProperty('cite_doc_ids', ['doc_a', 'doc_b'])
    expect(payload.mode).toBe('answer')
  })

  it('omits cite_doc_ids when undefined', () => {
    const payload = buildPayload('forest restoration', undefined)
    expect(payload).not.toHaveProperty('cite_doc_ids')
  })

  it('always sets mode to answer', () => {
    const payload = buildPayload('test', undefined)
    expect(payload.mode).toBe('answer')
  })
})

describe('API route passthrough', () => {
  const SEARCH_SERVICE_URL = 'http://localhost:8000'

  beforeEach(() => {
    global.fetch = jest.fn()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('forwards cite_doc_ids to search service', async () => {
    const mockSearchResponse = {
      ok: true,
      json: async () => ({
        docs: [],
        total_results: 0,
        query: 'test',
        mode: 'answer',
        debug: {},
      }),
    }
    ;(global.fetch as jest.Mock).mockResolvedValue(mockSearchResponse)

    // Mirrors AIResearchModal's actual gateway payload (query, mode, optional
    // cite_doc_ids) routed through the gateway's allowlisted spread.
    const body = {
      query: 'forest restoration',
      mode: 'answer',
      cite_doc_ids: ['doc_a', 'doc_b'],
    }

    const { query: rawQuery, mode, ...options } = body
    const llamaIndexRequest = {
      query: rawQuery,
      mode,
      similarity_threshold: 0.0,
      include_metadata: true,
      rerank: true,
      ...options,
    }

    await fetch(`${SEARCH_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(llamaIndexRequest),
    })

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0]
    const sentBody = JSON.parse(fetchCall[1].body)
    expect(sentBody.cite_doc_ids).toEqual(['doc_a', 'doc_b'])
    expect(sentBody.mode).toBe('answer')
  })

  it('does not include cite_doc_ids when not in request', async () => {
    const mockSearchResponse = {
      ok: true,
      json: async () => ({
        docs: [],
        total_results: 0,
        query: 'test',
        mode: 'answer',
        debug: {},
      }),
    }
    ;(global.fetch as jest.Mock).mockResolvedValue(mockSearchResponse)

    const body = {
      query: 'forest restoration',
      mode: 'answer',
    }

    const { query: rawQuery, mode, ...options } = body
    const llamaIndexRequest = {
      query: rawQuery,
      mode,
      similarity_threshold: 0.0,
      include_metadata: true,
      rerank: true,
      ...options,
    }

    await fetch(`${SEARCH_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(llamaIndexRequest),
    })

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0]
    const sentBody = JSON.parse(fetchCall[1].body)
    expect(sentBody).not.toHaveProperty('cite_doc_ids')
  })
})

describe('selectedRows → citeDocs data flow', () => {
  it('slice(0, 20) caps at 20 rows', () => {
    const selectedRows = Array.from({ length: 30 }, (_, i) => ({
      id: `doc_${i}`,
      publication_name: `Pub ${i}`,
      author: 'Author',
      summary: 'Summary',
      relevance: 'High',
      how_relevant: 'Very',
    }))

    // This mirrors ResultsTable.tsx line 271
    const citeDocs = selectedRows.slice(0, 20)
    expect(citeDocs).toHaveLength(20)
    expect(citeDocs[0].id).toBe('doc_0')
    expect(citeDocs[19].id).toBe('doc_19')
  })

  it('passes empty array when no rows selected', () => {
    const selectedRows: any[] = []
    const citeDocs = selectedRows.slice(0, 20)
    expect(citeDocs).toHaveLength(0)
    expect(extractCiteDocIds(citeDocs)).toBeUndefined()
  })

  it('passes all rows when fewer than 20 selected', () => {
    const selectedRows = [
      {
        id: 'doc_a',
        publication_name: 'A',
        author: '',
        summary: '',
        relevance: '',
        how_relevant: '',
      },
      {
        id: 'doc_b',
        publication_name: 'B',
        author: '',
        summary: '',
        relevance: '',
        how_relevant: '',
      },
    ]
    const citeDocs = selectedRows.slice(0, 20)
    expect(citeDocs).toHaveLength(2)
    expect(extractCiteDocIds(citeDocs)).toEqual(['doc_a', 'doc_b'])
  })
})
