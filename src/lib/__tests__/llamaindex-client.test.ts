import { chatCiteLlamaIndex } from '../llamaindex-client'

describe('chatCiteLlamaIndex', () => {
  const mockFetch = jest.fn()
  beforeEach(() => {
    global.fetch = mockFetch as unknown as typeof fetch
    mockFetch.mockReset()
  })

  it('forwards facets/expansion overrides and surfaces queryUnderstanding', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        docs: [],
        sources: [],
        usage: null,
        debug: {},
        query_understanding: {
          facets: [{ facet: 'year_min', value: '2020', action: 'hard' }],
          suggestions: [],
        },
      }),
    })

    const res = await chatCiteLlamaIndex('hydrogen since 2020', {
      facets: [{ facet: 'year_min', value: '2020' }],
    })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.facets).toEqual([{ facet: 'year_min', value: '2020' }])
    expect(res.queryUnderstanding.facets[0].facet).toBe('year_min')
  })

  it('returns null queryUnderstanding when upstream omits it', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        docs: [],
        sources: [],
        usage: null,
        debug: {},
      }),
    })
    const res = await chatCiteLlamaIndex('anything')
    expect(res.queryUnderstanding).toBeNull()
  })
})
