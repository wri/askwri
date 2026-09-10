/** @jest-environment node */
import { fetchExperts } from '@/lib/experts-client'

describe('fetchExperts', () => {
  afterEach(() => jest.restoreAllMocks())

  it('posts the request and returns the body', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, people: [] }), { status: 200 }),
      )
    const out = await fetchExperts({ query: 'buses', excluded_topics: ['Hub'] })
    expect(spy).toHaveBeenCalledWith(
      '/api/experts',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse((spy.mock.calls[0][1] as any).body)).toEqual({
      query: 'buses',
      excluded_topics: ['Hub'],
    })
    expect(out).toEqual({ ok: true, people: [] })
  })

  it('throws the server error on non-2xx', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, error: 'search service unavailable' }),
          { status: 502 },
        ),
      )
    await expect(fetchExperts({ query: 'x' })).rejects.toThrow(
      'search service unavailable',
    )
  })
})
