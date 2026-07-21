/** @jest-environment node */
import { NextRequest } from 'next/server'
import { signSession, SESSION_COOKIE } from '@/lib/auth/session'
import { requireIdentity } from '@/lib/auth/identity'
import { findUserById } from '@/db/queries/users'

jest.mock('@/db/data-source', () => ({
  initializeDatabase: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/db/queries/users', () => ({
  findUserById: jest.fn(),
}))

const mockFindUserById = findUserById as jest.MockedFunction<typeof findUserById>

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
  process.env.ADMIN_API_TOKEN = 'test-api-token'
})

beforeEach(() => {
  mockFindUserById.mockReset()
  mockFindUserById.mockResolvedValue({ id: 'u1', role: 'editor', active: true })
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

  it('accepts a lowercase bearer scheme (RFC 7235: scheme is case-insensitive)', async () => {
    const headers = new Headers()
    headers.set('authorization', 'bearer test-api-token')
    const req = new NextRequest('http://localhost/api/admin/test', { headers })
    const result = await requireIdentity(req)
    expect(result.identity).toEqual({ kind: 'token', role: 'admin' })
  })

  it('accepts a mixed-case Bearer scheme', async () => {
    const headers = new Headers()
    headers.set('authorization', 'BeArEr test-api-token')
    const req = new NextRequest('http://localhost/api/admin/test', { headers })
    const result = await requireIdentity(req)
    expect(result.identity).toEqual({ kind: 'token', role: 'admin' })
  })

  it('bearer-token identities skip the DB revalidation', async () => {
    const result = await requireIdentity(reqWith({ bearer: 'test-api-token' }))
    expect(result.identity).toEqual({ kind: 'token', role: 'admin' })
    expect(mockFindUserById).not.toHaveBeenCalled()
  })

  it('rejects a wrong bearer token', async () => {
    const result = await requireIdentity(reqWith({ bearer: 'nope' }))
    expect(result.response?.status).toBe(401)
  })

  it('401s when the session user no longer exists', async () => {
    mockFindUserById.mockResolvedValue(null)
    const token = await signSession({ userId: 'u1', username: 'a', role: 'editor' })
    const result = await requireIdentity(reqWith({ cookie: token }))
    expect(result.response?.status).toBe(401)
  })

  it('401s when the session user was deactivated', async () => {
    mockFindUserById.mockResolvedValue({ id: 'u1', role: 'editor', active: false })
    const token = await signSession({ userId: 'u1', username: 'a', role: 'editor' })
    const result = await requireIdentity(reqWith({ cookie: token }))
    expect(result.response?.status).toBe(401)
  })

  it('uses the DB role when it differs from the token role', async () => {
    // Token claims admin, DB says editor -> editor wins, admin check fails.
    mockFindUserById.mockResolvedValue({ id: 'u1', role: 'editor', active: true })
    const token = await signSession({ userId: 'u1', username: 'a', role: 'admin' })
    const result = await requireIdentity(reqWith({ cookie: token }), 'admin')
    expect(result.response?.status).toBe(403)

    // Token claims editor, DB says admin -> admin wins.
    mockFindUserById.mockResolvedValue({ id: 'u1', role: 'admin', active: true })
    const token2 = await signSession({ userId: 'u1', username: 'a', role: 'editor' })
    const result2 = await requireIdentity(reqWith({ cookie: token2 }), 'admin')
    expect(result2.identity).toEqual({ kind: 'user', userId: 'u1', username: 'a', role: 'admin' })
  })
})
