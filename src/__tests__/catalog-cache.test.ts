import { getCatalog, _resetForTests } from '@/lib/catalog-cache'

beforeEach(() => {
  _resetForTests()
  global.fetch = jest.fn()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('getCatalog', () => {
  it('fetches from /api/catalog and returns normalized items with index', async () => {
    const mockItems = [
      { file_name: 'doc1.pdf', title: 'Doc One', meta: {} },
      { file_name: 'doc2.pdf', title: 'Doc Two', meta: {} },
    ]
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: mockItems }),
    })

    const result = await getCatalog()

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith('/api/catalog')
    expect(result.catalog).toHaveLength(2)
    expect(result.index).toBeDefined()
    expect(result.index.byBase).toBeInstanceOf(Map)
    expect(result.index.bySlug).toBeInstanceOf(Map)
  })

  it('returns the same promise on concurrent calls (deduplication)', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    })

    const p1 = getCatalog()
    const p2 = getCatalog()

    expect(p1).toBe(p2)
    await p1
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('returns cached result on subsequent calls', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    })

    await getCatalog()
    await getCatalog()

    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('returns empty catalog and null index on fetch failure', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
    })

    const result = await getCatalog()

    expect(result.catalog).toEqual([])
    expect(result.index).toBeNull()
  })
})
