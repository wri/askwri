/** @jest-environment node */
import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import { AppDataSource } from '@/db/data-source'
import { User } from '@/db/entities/User.entity'
import { POST as login } from '@/app/api/admin/auth/login/route'
import { POST as createUserRoute } from '@/app/api/admin/users/route'
import { PATCH as patchUserRoute } from '@/app/api/admin/users/[id]/route'
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
  process.env.ADMIN_API_TOKEN = 'test-admin-token'
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

  it(
    '429s after 10 failed attempts, even with the right password',
    async () => {
      // Dedicated username so other tests are not throttled.
      const throttleUsername = `throttle_test_${Date.now()}`
      const repo = AppDataSource.getRepository(User)
      const u = await repo.save(
        repo.create({
          username: throttleUsername,
          passwordHash: await bcrypt.hash('pw-123456', 12),
          role: 'editor',
          active: true,
        }),
      )
      try {
        for (let i = 0; i < 10; i++) {
          const res = await login(loginReq({ username: throttleUsername, password: 'wrong' }))
          expect(res.status).toBe(401)
        }
        const blocked = await login(loginReq({ username: throttleUsername, password: 'wrong' }))
        expect(blocked.status).toBe(429)
        const withRightPassword = await login(
          loginReq({ username: throttleUsername, password: 'pw-123456' }),
        )
        expect(withRightPassword.status).toBe(429)
      } finally {
        await repo.delete({ id: u.id })
      }
    },
    60000,
  )
})

d('user management routes (DB integration)', () => {
  const createdUserIds: string[] = []

  function adminReq(method: string, url: string, body?: unknown) {
    return new NextRequest(url, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-admin-token',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  function loginReq(body: unknown) {
    return new NextRequest('http://localhost/api/admin/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
  }

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      for (const id of createdUserIds) {
        await AppDataSource.getRepository(User).delete({ id })
      }
    }
  })

  it('POST /admin/users creates a user and login works with new credentials', async () => {
    const username = `created_user_${Date.now()}`
    const password = 'ValidPassword123!'
    const res = await createUserRoute(
      adminReq('POST', 'http://localhost/api/admin/users', { username, password, role: 'editor' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.user.username).toBe(username)
    createdUserIds.push(body.user.id)

    const loginRes = await login(loginReq({ username, password }))
    expect(loginRes.status).toBe(200)
    const loginBody = await loginRes.json()
    expect(loginBody.ok).toBe(true)
  })

  it('POST /admin/users 400s on a short password', async () => {
    const res = await createUserRoute(
      adminReq('POST', 'http://localhost/api/admin/users', {
        username: `short_pw_${Date.now()}`,
        password: 'short',
        role: 'editor',
      }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  it('PATCH /admin/users/[id] deactivates user and login then 401s', async () => {
    const username = `deactivate_user_${Date.now()}`
    const password = 'ValidPassword456!'
    const createRes = await createUserRoute(
      adminReq('POST', 'http://localhost/api/admin/users', { username, password, role: 'editor' }),
    )
    expect(createRes.status).toBe(200)
    const { user } = await createRes.json()
    createdUserIds.push(user.id)

    const patchRes = await patchUserRoute(
      adminReq('PATCH', `http://localhost/api/admin/users/${user.id}`, { active: false }),
      { params: Promise.resolve({ id: user.id }) },
    )
    expect(patchRes.status).toBe(200)
    const patchBody = await patchRes.json()
    expect(patchBody.ok).toBe(true)

    const loginRes = await login(loginReq({ username, password }))
    expect(loginRes.status).toBe(401)
  })

  it('PATCH /admin/users/[id] 404s on a non-UUID id', async () => {
    const res = await patchUserRoute(
      adminReq('PATCH', 'http://localhost/api/admin/users/not-a-uuid', { active: false }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    )
    expect(res.status).toBe(404)
  })
})

d('last-admin guard (DB integration)', () => {
  const soloUsername = `solo_admin_${Date.now()}`
  let soloAdminId: string
  let parkedAdminIds: string[] = []

  function adminReq(method: string, url: string, body?: unknown) {
    return new NextRequest(url, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-admin-token',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const repo = AppDataSource.getRepository(User)
    // Park any pre-existing active admins so our test admin is the only one.
    const existing = await repo.find({ where: { role: 'admin', active: true } })
    parkedAdminIds = existing.map((u) => u.id)
    if (parkedAdminIds.length > 0) await repo.update(parkedAdminIds, { active: false })
    const solo = await repo.save(
      repo.create({
        username: soloUsername,
        passwordHash: await bcrypt.hash('SoloAdminPw123!', 12),
        role: 'admin',
        active: true,
      }),
    )
    soloAdminId = solo.id
  })

  afterAll(async () => {
    const repo = AppDataSource.getRepository(User)
    await repo.delete({ id: soloAdminId })
    if (parkedAdminIds.length > 0) await repo.update(parkedAdminIds, { active: true })
    // Last describe in this file: close the connection so jest exits cleanly.
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it('409s when demoting the last active admin', async () => {
    const res = await patchUserRoute(
      adminReq('PATCH', `http://localhost/api/admin/users/${soloAdminId}`, { role: 'editor' }),
      { params: Promise.resolve({ id: soloAdminId }) },
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('cannot remove the last active admin')
  })

  it('409s when deactivating the last active admin', async () => {
    const res = await patchUserRoute(
      adminReq('PATCH', `http://localhost/api/admin/users/${soloAdminId}`, { active: false }),
      { params: Promise.resolve({ id: soloAdminId }) },
    )
    expect(res.status).toBe(409)
  })

  it('allows demotion once another active admin exists', async () => {
    const repo = AppDataSource.getRepository(User)
    const second = await repo.save(
      repo.create({
        username: `second_admin_${Date.now()}`,
        passwordHash: 'not-a-real-hash',
        role: 'admin',
        active: true,
      }),
    )
    try {
      const res = await patchUserRoute(
        adminReq('PATCH', `http://localhost/api/admin/users/${soloAdminId}`, { role: 'editor' }),
        { params: Promise.resolve({ id: soloAdminId }) },
      )
      expect(res.status).toBe(200)
    } finally {
      await repo.update(soloAdminId, { role: 'admin' })
      await repo.delete({ id: second.id })
    }
  })
})
