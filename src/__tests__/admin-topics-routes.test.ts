/** @jest-environment node */
import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import { AppDataSource } from '@/db/data-source'
import { User } from '@/db/entities/User.entity'
import { POST as login } from '@/app/api/admin/auth/login/route'
import { GET as getTopics, POST as createTopic } from '@/app/api/admin/topics/route'
import { SESSION_COOKIE } from '@/lib/auth/session'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
  process.env.ADMIN_API_TOKEN = 'test-admin-token'
})

function makeReq(
  method: string,
  url: string,
  body?: unknown,
  cookie?: string,
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (cookie) headers['cookie'] = `${SESSION_COOKIE}=${cookie}`
  return new NextRequest(url, {
    method,
    headers,
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

async function getSessionCookie(
  username: string,
  password: string,
): Promise<string> {
  const res = await login(loginReq({ username, password }))
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`)
  const cookie = res.cookies.get(SESSION_COOKIE)?.value
  if (!cookie) throw new Error('no session cookie')
  return cookie
}

d('topics API routes (DB integration)', () => {
  const adminUser = `topics_admin_${Date.now()}`
  const editorUser = `topics_editor_${Date.now()}`
  let adminCookie = ''
  let editorCookie = ''
  let adminId = ''
  let editorId = ''
  const tagIds: string[] = []
  const docIds: string[] = []

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const repo = AppDataSource.getRepository(User)
    const admin = await repo.save(
      repo.create({
        username: adminUser,
        passwordHash: await bcrypt.hash('AdminPw123!', 12),
        role: 'admin',
        active: true,
      }),
    )
    adminId = admin.id
    const editor = await repo.save(
      repo.create({
        username: editorUser,
        passwordHash: await bcrypt.hash('EditorPw123!', 12),
        role: 'editor',
        active: true,
      }),
    )
    editorId = editor.id
    adminCookie = await getSessionCookie(adminUser, 'AdminPw123!')
    editorCookie = await getSessionCookie(editorUser, 'EditorPw123!')
  })

  afterAll(async () => {
    // cleanup topic tags created by POST test
    for (const tid of tagIds) {
      await AppDataSource.query(
        `DELETE FROM tag_aliases WHERE tag_id = $1`,
        [tid],
      )
      await AppDataSource.query(`DELETE FROM tags WHERE id = $1`, [tid])
    }
    // cleanup docs
    for (const did of docIds) {
      await AppDataSource.query(`DELETE FROM document_tags WHERE document_id = $1`, [did])
      await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [did])
    }
    // cleanup reclassify jobs
    await AppDataSource.query(
      `DELETE FROM reclassify_jobs WHERE scope_tag_id = ANY($1::uuid[]) OR scope_tag_id IS NULL`,
      [tagIds.length ? tagIds : ['00000000-0000-0000-0000-000000000000']],
    )
    // cleanup audit
    for (const tid of tagIds) {
      await AppDataSource.query(`DELETE FROM audit_log WHERE entity_id = $1`, [tid])
    }
    // cleanup users
    const repo = AppDataSource.getRepository(User)
    await repo.delete({ id: adminId })
    await repo.delete({ id: editorId })
    await AppDataSource.destroy()
  })

  it('GET /api/admin/topics returns 200 with {ok:true, tags:Array}', async () => {
    const res = await getTopics(makeReq('GET', 'http://localhost/api/admin/topics', undefined, adminCookie))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.tags)).toBe(true)
  })

  it('GET /api/admin/topics works with editor session (reads allowed)', async () => {
    const res = await getTopics(makeReq('GET', 'http://localhost/api/admin/topics', undefined, editorCookie))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.tags)).toBe(true)
  })

  it('GET /api/admin/topics returns 401 without auth', async () => {
    const res = await getTopics(makeReq('GET', 'http://localhost/api/admin/topics'))
    expect(res.status).toBe(401)
  })

  it('POST /api/admin/topics creates a topic (admin)', async () => {
    const res = await createTopic(
      makeReq('POST', 'http://localhost/api/admin/topics', {
        valueId: `__route_test_${Date.now()}`,
        description: 'route test tag',
        aliases: ['__rt_alias__'],
      }, adminCookie),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.tag).toBeDefined()
    tagIds.push(body.tag.id)
  })

  it('POST /api/admin/topics returns 403 for non-admin (editor)', async () => {
    const res = await createTopic(
      makeReq('POST', 'http://localhost/api/admin/topics', {
        valueId: `__route_forbidden_${Date.now()}`,
      }, editorCookie),
    )
    expect(res.status).toBe(403)
  })

  it('POST /api/admin/topics returns 409 on duplicate', async () => {
    const valueId = `__route_dup_${Date.now()}`
    // first create succeeds
    const r1 = await createTopic(
      makeReq('POST', 'http://localhost/api/admin/topics', { valueId }, adminCookie),
    )
    expect(r1.status).toBe(200)
    tagIds.push((await r1.json()).tag.id)
    // second create → 409
    const r2 = await createTopic(
      makeReq('POST', 'http://localhost/api/admin/topics', { valueId }, adminCookie),
    )
    expect(r2.status).toBe(409)
  })

  it('GET /api/admin/topics works with bearer token (admin)', async () => {
    const res = await getTopics(
      new NextRequest('http://localhost/api/admin/topics', {
        headers: { authorization: 'Bearer test-admin-token' },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })
})
