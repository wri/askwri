/** @jest-environment node */
import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import { AppDataSource } from '@/db/data-source'
import { User } from '@/db/entities/User.entity'
import { POST as login } from '@/app/api/admin/auth/login/route'
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
})

d('login route (DB integration)', () => {
  const username = `login_test_${Date.now()}`

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const repo = AppDataSource.getRepository(User)
    await repo.save(
      repo.create({
        username,
        passwordHash: await bcrypt.hash('pw-123456', 12),
        role: 'editor',
        active: true,
      }),
    )
  })

  afterAll(async () => {
    await AppDataSource.getRepository(User).delete({ username })
    await AppDataSource.destroy()
  })

  function loginReq(body: unknown) {
    return new NextRequest('http://localhost/api/admin/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
  }

  it('sets a verifiable session cookie on success', async () => {
    const res = await login(loginReq({ username, password: 'pw-123456' }))
    expect(res.status).toBe(200)
    const cookie = res.cookies.get(SESSION_COOKIE)?.value
    expect(cookie).toBeTruthy()
    const session = await verifySession(cookie!)
    expect(session?.username).toBe(username)
    expect(session?.role).toBe('editor')
  })

  it('401s on a wrong password', async () => {
    const res = await login(loginReq({ username, password: 'wrong' }))
    expect(res.status).toBe(401)
  })

  it('400s on a missing body', async () => {
    const res = await login(loginReq({}))
    expect(res.status).toBe(400)
  })
})
