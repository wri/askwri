/** @jest-environment node */
import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import { AppDataSource } from '@/db/data-source'
import { User } from '@/db/entities/User.entity'
import { POST as login } from '@/app/api/admin/auth/login/route'
import {
  GET as getTopics,
  POST as createTopic,
} from '@/app/api/admin/topics/route'
import { POST as importTopics } from '@/app/api/admin/topics/import/route'
import { POST as mergeTopic } from '@/app/api/admin/topics/[id]/merge/route'
import { SESSION_COOKIE } from '@/lib/auth/session'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
  process.env.ADMIN_API_TOKEN = 'test-admin-token'
})

function makeReq(method: string, url: string, body?: unknown, cookie?: string) {
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
    // Delete test-owned jobs before their scoped tags can become null.
    if (docIds.length > 0) {
      await AppDataSource.query(
        `DELETE FROM reclassify_jobs WHERE document_id = ANY($1::uuid[])`,
        [docIds],
      )
    }
    for (const did of docIds) {
      await AppDataSource.query(
        `DELETE FROM document_tags WHERE document_id = $1`,
        [did],
      )
      await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [did])
    }
    for (const tid of tagIds) {
      await AppDataSource.query(`DELETE FROM tag_aliases WHERE tag_id = $1`, [
        tid,
      ])
      await AppDataSource.query(`DELETE FROM tags WHERE id = $1`, [tid])
    }
    for (const tid of tagIds) {
      await AppDataSource.query(`DELETE FROM audit_log WHERE entity_id = $1`, [
        tid,
      ])
    }
    const repo = AppDataSource.getRepository(User)
    await repo.delete({ id: adminId })
    await repo.delete({ id: editorId })
    await AppDataSource.destroy()
  })

  it('GET /api/admin/topics returns 200 with {ok:true, tags:Array}', async () => {
    const res = await getTopics(
      makeReq(
        'GET',
        'http://localhost/api/admin/topics',
        undefined,
        adminCookie,
      ),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.tags)).toBe(true)
  })

  it('GET /api/admin/topics works with editor session (reads allowed)', async () => {
    const res = await getTopics(
      makeReq(
        'GET',
        'http://localhost/api/admin/topics',
        undefined,
        editorCookie,
      ),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.tags)).toBe(true)
  })

  it('GET /api/admin/topics returns 401 without auth', async () => {
    const res = await getTopics(
      makeReq('GET', 'http://localhost/api/admin/topics'),
    )
    expect(res.status).toBe(401)
  })

  it('POST /api/admin/topics creates a topic (admin)', async () => {
    const res = await createTopic(
      makeReq(
        'POST',
        'http://localhost/api/admin/topics',
        {
          valueId: `__route_test_${Date.now()}`,
          description: 'route test tag',
          aliases: ['__rt_alias__'],
        },
        adminCookie,
      ),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.tag).toBeDefined()
    tagIds.push(body.tag.id)
  })

  it('POST /api/admin/topics returns 403 for non-admin (editor)', async () => {
    const res = await createTopic(
      makeReq(
        'POST',
        'http://localhost/api/admin/topics',
        {
          valueId: `__route_forbidden_${Date.now()}`,
        },
        editorCookie,
      ),
    )
    expect(res.status).toBe(403)
  })

  it('POST /api/admin/topics returns 409 on duplicate', async () => {
    const valueId = `__route_dup_${Date.now()}`
    // first create succeeds
    const r1 = await createTopic(
      makeReq(
        'POST',
        'http://localhost/api/admin/topics',
        { valueId },
        adminCookie,
      ),
    )
    expect(r1.status).toBe(200)
    tagIds.push((await r1.json()).tag.id)
    // second create → 409
    const r2 = await createTopic(
      makeReq(
        'POST',
        'http://localhost/api/admin/topics',
        { valueId },
        adminCookie,
      ),
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

  it('POST /api/admin/topics/:id/merge returns atomic moved/enqueued counts without a second enqueue audit', async () => {
    const nonce = crypto.randomUUID()
    const [target] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('topic', $1, 'v1') RETURNING id`,
      [`__route_merge_target_${nonce}__`],
    )
    const [source] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('topic', $1, 'v1') RETURNING id`,
      [`__route_merge_source_${nonce}__`],
    )
    tagIds.push(target.id, source.id)
    const [document] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Route merge', 'ready') RETURNING id`,
      [`__route_merge_${nonce}__`, `documents/__route_merge_${nonce}__.pdf`],
    )
    docIds.push(document.id)
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, status)
       VALUES ($1, $2, 'llm', 'accepted')`,
      [document.id, source.id],
    )

    const response = await mergeTopic(
      makeReq(
        'POST',
        `http://localhost/api/admin/topics/${source.id}/merge`,
        { intoTagId: target.id },
        adminCookie,
      ),
      { params: Promise.resolve({ id: source.id }) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      moved: 1,
      enqueued: 1,
    })
    const [secondEnqueueAudit] = await AppDataSource.query(
      `SELECT id FROM audit_log
       WHERE actor_user_id = $1 AND entity_id = $2
         AND action = 'reclassify_enqueue'`,
      [adminId, target.id],
    )
    expect(secondEnqueueAudit).toBeUndefined()
  })

  it('POST /api/admin/topics/import maps a typed CSV conflict to 409', async () => {
    const label = `__route_import_program_${crypto.randomUUID()}__`
    const csv = [
      'label,description,aliases,parent,facet,id',
      `${label},,,,program,`,
    ].join('\n')

    try {
      const response = await importTopics(
        makeReq(
          'POST',
          'http://localhost/api/admin/topics/import',
          { csv },
          adminCookie,
        ),
      )
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('conflict'),
      })
    } finally {
      const inserted: any[] = await AppDataSource.query(
        `DELETE FROM tags WHERE value_id = $1 RETURNING id`,
        [label],
      )
      for (const tag of inserted) {
        const index = tagIds.indexOf(tag.id)
        if (index >= 0) tagIds.splice(index, 1)
      }
    }
  })

  it('POST /api/admin/topics/import maps a label ownership collision to 409', async () => {
    const nonce = crypto.randomUUID()
    const firstLabel = `__route_import_owner_a_${nonce}__`
    const secondLabel = `__route_import_owner_b_${nonce}__`
    const [first] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('topic', $1, 'v1') RETURNING id`,
      [firstLabel],
    )
    const [second] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version)
       VALUES ('topic', $1, 'v1') RETURNING id`,
      [secondLabel],
    )
    tagIds.push(first.id, second.id)
    const csv = [
      'label,description,aliases,parent,facet,id',
      `${secondLabel},,,,topic,${first.id}`,
    ].join('\n')
    const consoleError = jest.spyOn(console, 'error').mockImplementation()

    try {
      const response = await importTopics(
        makeReq(
          'POST',
          'http://localhost/api/admin/topics/import',
          { csv },
          adminCookie,
        ),
      )
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('conflict'),
      })
      const labels: any[] = await AppDataSource.query(
        `SELECT id, value_id FROM tags WHERE id = ANY($1::uuid[])`,
        [[first.id, second.id]],
      )
      expect(labels).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, value_id: firstLabel }),
          expect.objectContaining({ id: second.id, value_id: secondLabel }),
        ]),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('POST /api/admin/topics/import maps unexpected infrastructure failures to 500', async () => {
    const nonce = crypto.randomUUID().replaceAll('-', '')
    const label = `__route_import_failure_${nonce}__`
    const auditFunction = `task2_route_audit_fail_${nonce}`
    const auditTrigger = `task2_route_audit_fail_trigger_${nonce}`
    await AppDataSource.query(
      `CREATE FUNCTION ${auditFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.action = 'tag_import' AND NEW.actor_user_id = '${adminId}'::uuid THEN
           RAISE EXCEPTION 'task2 route audit failure';
         END IF;
         RETURN NEW;
       END;
       $$`,
    )
    await AppDataSource.query(
      `CREATE TRIGGER ${auditTrigger} BEFORE INSERT ON audit_log
       FOR EACH ROW EXECUTE FUNCTION ${auditFunction}()`,
    )

    const csv = [
      'label,description,aliases,parent,facet,id',
      `${label},,,,topic,`,
    ].join('\n')
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    try {
      const response = await importTopics(
        makeReq(
          'POST',
          'http://localhost/api/admin/topics/import',
          { csv },
          adminCookie,
        ),
      )
      expect(response.status).toBe(500)
    } finally {
      await AppDataSource.query(
        `DROP TRIGGER IF EXISTS ${auditTrigger} ON audit_log`,
      )
      await AppDataSource.query(`DROP FUNCTION IF EXISTS ${auditFunction}()`)
      await AppDataSource.query(`DELETE FROM tags WHERE value_id = $1`, [label])
      consoleError.mockRestore()
    }
  })
})
