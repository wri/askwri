/** @jest-environment node */
import { NextRequest } from 'next/server'
import { signSession, SESSION_COOKIE } from '@/lib/auth/session'
import { requireIdentity } from '@/lib/auth/identity'

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
  process.env.ADMIN_API_TOKEN = 'test-api-token'
})

function reqWith(init?: { cookie?: string; bearer?: string }) {
  const headers = new Headers()
  if (init?.cookie) headers.set('cookie', `${SESSION_COOKIE}=${init.cookie}`)
  if (init?.bearer) headers.set('authorization', `Bearer ${init.bearer}`)
  return new NextRequest('http://localhost/api/admin/test', { headers })
}

describe('requireIdentity', () => {
  it('returns 401 with no credentials', async () => {
    const result = await requireIdentity(reqWith())
    expect(result.response?.status).toBe(401)
  })

  it('accepts a valid session cookie', async () => {
    const token = await signSession({ userId: 'u1', username: 'a', role: 'editor' })
    const result = await requireIdentity(reqWith({ cookie: token }))
    expect(result.identity).toEqual({ kind: 'user', userId: 'u1', username: 'a', role: 'editor' })
  })

  it('enforces admin role', async () => {
    const token = await signSession({ userId: 'u1', username: 'a', role: 'editor' })
    const result = await requireIdentity(reqWith({ cookie: token }), 'admin')
    expect(result.response?.status).toBe(403)
  })

  it('accepts the bearer token as admin', async () => {
    const result = await requireIdentity(reqWith({ bearer: 'test-api-token' }), 'admin')
    expect(result.identity).toEqual({ kind: 'token', role: 'admin' })
  })

  it('rejects a wrong bearer token', async () => {
    const result = await requireIdentity(reqWith({ bearer: 'nope' }))
    expect(result.response?.status).toBe(401)
  })
})
