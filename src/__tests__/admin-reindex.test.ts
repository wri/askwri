/** @jest-environment node */
import { triggerReindex } from '@/lib/search-reindex'

describe('triggerReindex', () => {
  const realFetch = global.fetch

  afterEach(() => {
    global.fetch = realFetch
    delete process.env.SEARCH_SERVICE_URL
  })

  it('reports missing configuration', async () => {
    delete process.env.SEARCH_SERVICE_URL
    delete process.env.LLAMAINDEX_SERVICE_URL
    expect((await triggerReindex()).ok).toBe(false)
  })

  it('POSTs to /reindex and reports success', async () => {
    process.env.SEARCH_SERVICE_URL = 'http://search:8000'
    const mock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = mock as any
    expect((await triggerReindex()).ok).toBe(true)
    expect(mock).toHaveBeenCalledWith('http://search:8000/reindex', expect.objectContaining({ method: 'POST' }))
  })

  it('reports HTTP failures without throwing', async () => {
    process.env.SEARCH_SERVICE_URL = 'http://search:8000'
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any
    const result = await triggerReindex()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('500')
  })
})
