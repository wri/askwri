/**
 * @jest-environment node
 *
 * Unit tests for /api/catalog response headers (issue #302): gzip
 * compression, ETag/304 conditional requests, and Cache-Control. The DB
 * layer is mocked; source-selection logic is covered by
 * catalog-route.db.test.ts.
 */

import { gunzipSync } from 'node:zlib'
import { NextRequest } from 'next/server'

jest.mock('@/db/data-source', () => ({
  initializeDatabase: jest.fn().mockResolvedValue(undefined),
}))

const mockItems = [
  {
    file_id: '',
    file_name: 'docs/a.pdf',
    external_file_id: '',
    meta: { file_path: 'docs/a.pdf', metadata: '{}', summary: 'A summary' },
  },
  {
    file_id: '',
    file_name: 'docs/b.pdf',
    external_file_id: '',
    meta: { file_path: 'docs/b.pdf', metadata: '{}', summary: 'B summary' },
  },
]

const getCatalogItems = jest.fn()
jest.mock('@/db/queries/getCatalogItems', () => ({
  getCatalogItems: (...args: unknown[]) => getCatalogItems(...args),
}))

async function get(headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/catalog/route')
  return GET(new NextRequest('http://localhost/api/catalog', { headers }))
}

beforeEach(() => {
  delete process.env.CATALOG_SOURCE
  getCatalogItems.mockResolvedValue(mockItems)
})

describe('/api/catalog headers (issue #302)', () => {
  it('serves gzip when the client accepts it', async () => {
    const res = await get({ 'accept-encoding': 'gzip, deflate, br' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('vary')).toContain('Accept-Encoding')
    const body = JSON.parse(
      gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'),
    )
    expect(body.ok).toBe(true)
    expect(body.count).toBe(2)
    expect(body.items).toHaveLength(2)
    expect(body.source).toBe('postgres')
  })

  it('serves identity encoding when the client does not accept gzip', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBeNull()
    const body = await res.json()
    expect(body.count).toBe(2)
  })

  it('sets Cache-Control and a strong ETag', async () => {
    const res = await get()
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=300, stale-while-revalidate=3600',
    )
    const etag = res.headers.get('etag')
    expect(etag).toMatch(/^"[^"]+"$/)
  })

  it('keeps the ETag stable across requests for identical content', async () => {
    const first = await get()
    const second = await get()
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'))
  })

  it('changes the ETag when the catalog changes', async () => {
    const first = await get()
    getCatalogItems.mockResolvedValue(mockItems.slice(0, 1))
    const second = await get()
    expect(second.headers.get('etag')).not.toBe(first.headers.get('etag'))
  })

  it('returns 304 with no body on a matching If-None-Match', async () => {
    const first = await get()
    const etag = first.headers.get('etag') as string
    const res = await get({ 'if-none-match': etag })
    expect(res.status).toBe(304)
    expect(await res.text()).toBe('')
    expect(res.headers.get('etag')).toBe(etag)
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=300, stale-while-revalidate=3600',
    )
  })

  it('matches If-None-Match lists and weak validators', async () => {
    const etag = (await get()).headers.get('etag') as string
    const res = await get({ 'if-none-match': `"stale", W/${etag}` })
    expect(res.status).toBe(304)
  })

  it('returns full body when If-None-Match does not match', async () => {
    const res = await get({ 'if-none-match': '"something-else"' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(2)
  })

  it('does not cache error responses', async () => {
    getCatalogItems.mockRejectedValue(new Error('db down'))
    const res = await get()
    expect(res.status).toBe(500)
    expect(res.headers.get('cache-control')).toBeNull()
    expect(res.headers.get('etag')).toBeNull()
  })
})
