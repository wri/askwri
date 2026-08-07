/** @jest-environment node */
import { NextRequest } from 'next/server'
import { signSession, SESSION_COOKIE } from '@/lib/auth/session'
import { proxy } from '@/proxy'

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
  process.env.ADMIN_API_TOKEN = 'test-api-token'
})

function req(path: string, init?: { cookie?: string; bearer?: string }) {
  const headers = new Headers()
  if (init?.cookie) headers.set('cookie', `${SESSION_COOKIE}=${init.cookie}`)
  if (init?.bearer) headers.set('authorization', `Bearer ${init.bearer}`)
  return new NextRequest(`http://localhost${path}`, { headers })
}

describe('proxy auth gate', () => {
  it('redirects unauthenticated /admin pages to /admin/login', async () => {
    const res = await proxy(req('/admin/review'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/admin/login')
  })

  it('returns 401 JSON for unauthenticated admin APIs', async () => {
    const res = await proxy(req('/api/admin/review-queue'))
    expect(res.status).toBe(401)
  })

  it('lets /admin/login through without a session', async () => {
    const res = await proxy(req('/admin/login'))
    expect(res.status).toBe(200)
  })

  it('lets a valid session through', async () => {
    const token = await signSession({
      userId: 'u1',
      username: 'a',
      role: 'editor',
    })
    const res = await proxy(req('/admin/review', { cookie: token }))
    expect(res.status).toBe(200)
  })

  it('lets the bearer token through on /api/import-documents', async () => {
    const res = await proxy(
      req('/api/import-documents', { bearer: 'test-api-token' }),
    )
    expect(res.status).toBe(200)
  })
})
