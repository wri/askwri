/** @jest-environment node */
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/admin/worker-health/route'

// Use the ADMIN_API_TOKEN bearer (grants admin, no DB user lookup) so the route
// test is independent of the users table. The query-level test
// (worker-health.db.test.ts) proves the health logic against the live DB.
const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('GET /api/admin/worker-health (route + auth wiring)', () => {
  const originalToken = process.env.ADMIN_API_TOKEN
  beforeAll(() => {
    process.env.ADMIN_API_TOKEN = 'test-admin-token'
  })
  afterAll(() => {
    if (originalToken === undefined) delete process.env.ADMIN_API_TOKEN
    else process.env.ADMIN_API_TOKEN = originalToken
  })

  it('returns 401 without auth', async () => {
    const req = new NextRequest('http://localhost/api/admin/worker-health')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns ok + health shape with a valid bearer token', async () => {
    const req = new NextRequest('http://localhost/api/admin/worker-health', {
      headers: { authorization: 'Bearer test-admin-token' },
    })
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.health).toHaveProperty('queueDepth')
    expect(body.health).toHaveProperty('lastProcessedAt')
    expect(body.health).toHaveProperty('intakeBacklog')
    expect(body.health).toHaveProperty('status')
    expect(['idle', 'processing', 'stale']).toContain(body.health.status)
  })
})
