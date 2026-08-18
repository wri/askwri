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
import {
  GET as estimateReclassifyRoute,
  POST as enqueueReclassifyRoute,
} from '@/app/api/admin/topics/reclassify/route'
import { SESSION_COOKIE } from '@/lib/auth/session'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip
const routeRunId = crypto.randomUUID()
const adminApiToken = `test-admin-token-${routeRunId}`
let previousSessionSecret: string | undefined
let previousAdminApiToken: string | undefined

beforeAll(() => {
  previousSessionSecret = process.env.SESSION_SECRET
  previousAdminApiToken = process.env.ADMIN_API_TOKEN
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
  process.env.ADMIN_API_TOKEN = adminApiToken
})

afterAll(() => {
  if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET
  else process.env.SESSION_SECRET = previousSessionSecret

  if (previousAdminApiToken === undefined) delete process.env.ADMIN_API_TOKEN
  else process.env.ADMIN_API_TOKEN = previousAdminApiToken
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
  const adminUser = `topics_admin_${routeRunId}`
  const editorUser = `topics_editor_${routeRunId}`
  let adminCookie = ''
  let editorCookie = ''
  let adminId = ''
  let editorId = ''
  const tagIds: string[] = []
  const docIds: string[] = []
  const jobRunIds: string[] = []

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
    if (!AppDataSource.isInitialized) return
    // Delete test-owned jobs before their scoped tags can become null.
    if (docIds.length > 0 || jobRunIds.length > 0) {
      await AppDataSource.query(
        `DELETE FROM reclassify_jobs
         WHERE document_id = ANY($1::uuid[]) OR run_id = ANY($2::uuid[])`,
        [docIds, jobRunIds],
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
    const userIds = [adminId, editorId].filter((id) => id !== '')
    if (userIds.length > 0) {
      await AppDataSource.query(
        `DELETE FROM audit_log WHERE actor_user_id = ANY($1::uuid[])`,
        [userIds],
      )
    }
    const repo = AppDataSource.getRepository(User)
    if (adminId) await repo.delete({ id: adminId })
    if (editorId) await repo.delete({ id: editorId })
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
    const valueId = `__route_test_${routeRunId}`
    try {
      const res = await createTopic(
        makeReq(
          'POST',
          'http://localhost/api/admin/topics',
          {
            valueId,
            description: 'route test tag',
            aliases: [`__rt_alias_${routeRunId}__`],
          },
          adminCookie,
        ),
      )
      const [created] = await AppDataSource.query(
        `SELECT id FROM tags
         WHERE facet = 'topic' AND taxonomy_version = 'v1' AND value_id = $1`,
        [valueId],
      )
      if (created) tagIds.push(created.id)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(created).toBeDefined()
      expect(body.ok).toBe(true)
      expect(body.tag).toMatchObject({ id: created.id, valueId })
    } finally {
      await AppDataSource.query(`DELETE FROM tags WHERE value_id = $1`, [
        valueId,
      ])
    }
  })

  it('POST /api/admin/topics returns 403 for non-admin (editor)', async () => {
    const valueId = `__route_forbidden_${routeRunId}`
    try {
      const res = await createTopic(
        makeReq(
          'POST',
          'http://localhost/api/admin/topics',
          { valueId },
          editorCookie,
        ),
      )
      const [inserted] = await AppDataSource.query(
        `SELECT id FROM tags WHERE value_id = $1`,
        [valueId],
      )
      if (inserted) tagIds.push(inserted.id)

      expect(res.status).toBe(403)
      expect(inserted).toBeUndefined()
    } finally {
      await AppDataSource.query(`DELETE FROM tags WHERE value_id = $1`, [
        valueId,
      ])
    }
  })

  it('POST /api/admin/topics returns 409 on duplicate', async () => {
    const valueId = `__route_dup_${routeRunId}`
    try {
      const r1 = await createTopic(
        makeReq(
          'POST',
          'http://localhost/api/admin/topics',
          { valueId },
          adminCookie,
        ),
      )
      const [created] = await AppDataSource.query(
        `SELECT id FROM tags
         WHERE facet = 'topic' AND taxonomy_version = 'v1' AND value_id = $1`,
        [valueId],
      )
      if (created) tagIds.push(created.id)

      expect(r1.status).toBe(200)
      expect(created).toBeDefined()
      await expect(r1.json()).resolves.toMatchObject({
        ok: true,
        tag: { id: created.id, valueId },
      })

      const r2 = await createTopic(
        makeReq(
          'POST',
          'http://localhost/api/admin/topics',
          { valueId },
          adminCookie,
        ),
      )
      expect(r2.status).toBe(409)
    } finally {
      await AppDataSource.query(`DELETE FROM tags WHERE value_id = $1`, [
        valueId,
      ])
    }
  })

  it('GET /api/admin/topics works with bearer token (admin)', async () => {
    const res = await getTopics(
      new NextRequest('http://localhost/api/admin/topics', {
        headers: { authorization: `Bearer ${adminApiToken}` },
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
      const [inserted] = await AppDataSource.query(
        `SELECT id FROM tags WHERE value_id = $1`,
        [label],
      )
      if (inserted) tagIds.push(inserted.id)

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('conflict'),
      })
      expect(inserted).toBeUndefined()
    } finally {
      await AppDataSource.query(`DELETE FROM tags WHERE value_id = $1`, [label])
    }
  })

  it('POST /api/admin/topics/import maps a label ownership collision to 409', async () => {
    const nonce = crypto.randomUUID()
    const firstLabel = `__route_import_owner_a_${nonce}__`
    const secondLabel = `__route_import_owner_b_${nonce}__`
    const consoleError = jest.spyOn(console, 'error').mockImplementation()

    try {
      const [first] = await AppDataSource.query(
        `INSERT INTO tags (facet, value_id, taxonomy_version)
         VALUES ('topic', $1, 'v1') RETURNING id`,
        [firstLabel],
      )
      tagIds.push(first.id)
      const [second] = await AppDataSource.query(
        `INSERT INTO tags (facet, value_id, taxonomy_version)
         VALUES ('topic', $1, 'v1') RETURNING id`,
        [secondLabel],
      )
      tagIds.push(second.id)
      const csv = [
        'label,description,aliases,parent,facet,id',
        `${secondLabel},,,,topic,${first.id}`,
      ].join('\n')
      const response = await importTopics(
        makeReq(
          'POST',
          'http://localhost/api/admin/topics/import',
          { csv },
          adminCookie,
        ),
      )
      const labels: any[] = await AppDataSource.query(
        `SELECT id, value_id FROM tags WHERE id = ANY($1::uuid[])`,
        [[first.id, second.id]],
      )

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('conflict'),
      })
      expect(labels).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, value_id: firstLabel }),
          expect.objectContaining({ id: second.id, value_id: secondLabel }),
        ]),
      )
    } finally {
      await AppDataSource.query(
        `DELETE FROM tags WHERE value_id = ANY($1::text[])`,
        [[firstLabel, secondLabel]],
      )
      consoleError.mockRestore()
    }
  })

  it('POST /api/admin/topics/import maps unexpected infrastructure failures to 500', async () => {
    const nonce = crypto.randomUUID().replaceAll('-', '')
    const label = `__route_import_failure_${nonce}__`
    const auditFunction = `task2_route_audit_fail_${nonce}`
    const auditTrigger = `task2_route_audit_fail_trigger_${nonce}`
    const csv = [
      'label,description,aliases,parent,facet,id',
      `${label},,,,topic,`,
    ].join('\n')
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    try {
      await AppDataSource.query(
        `CREATE FUNCTION ${auditFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action = 'tag_import'
              AND NEW.actor_user_id = '${adminId}'::uuid THEN
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
      const response = await importTopics(
        makeReq(
          'POST',
          'http://localhost/api/admin/topics/import',
          { csv },
          adminCookie,
        ),
      )
      const [inserted] = await AppDataSource.query(
        `SELECT id FROM tags WHERE value_id = $1`,
        [label],
      )
      if (inserted) tagIds.push(inserted.id)

      expect(response.status).toBe(500)
      expect(inserted).toBeUndefined()
    } finally {
      await AppDataSource.query(
        `DROP TRIGGER IF EXISTS ${auditTrigger} ON audit_log`,
      )
      await AppDataSource.query(`DROP FUNCTION IF EXISTS ${auditFunction}()`)
      await AppDataSource.query(`DELETE FROM tags WHERE value_id = $1`, [label])
      consoleError.mockRestore()
    }
  })

  describe('/api/admin/topics/reclassify contract', () => {
    it('GET estimates an explicit all scope without enqueueing work', async () => {
      const nonce = crypto.randomUUID()
      const beforeResponse = await estimateReclassifyRoute(
        makeReq(
          'GET',
          'http://localhost/api/admin/topics/reclassify?scope=all',
          undefined,
          adminCookie,
        ),
      )
      const before = await beforeResponse.json()
      const [document] = await AppDataSource.query(
        `INSERT INTO documents (external_id, s3_key, title, status)
         VALUES ($1, $2, 'Estimate all', 'ready') RETURNING id`,
        [`__route_estimate_all_${nonce}__`, `documents/${nonce}.pdf`],
      )
      docIds.push(document.id)
      try {
        const response = await estimateReclassifyRoute(
          makeReq(
            'GET',
            'http://localhost/api/admin/topics/reclassify?scope=all',
            undefined,
            adminCookie,
          ),
        )
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
          ok: true,
          eligible: before.eligible + 1,
          estCost: +((before.eligible + 1) * 0.0008).toFixed(4),
        })
        const [job] = await AppDataSource.query(
          `SELECT id FROM reclassify_jobs WHERE document_id = $1`,
          [document.id],
        )
        expect(job).toBeUndefined()
      } finally {
        await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [
          document.id,
        ])
      }
    })

    it('GET estimates an explicit v1 topic scope without enqueueing work', async () => {
      const nonce = crypto.randomUUID()
      const [tag] = await AppDataSource.query(
        `INSERT INTO tags (facet, value_id, taxonomy_version)
         VALUES ('topic', $1, 'v1') RETURNING id`,
        [`__route_estimate_tag_${nonce}__`],
      )
      tagIds.push(tag.id)
      const [document] = await AppDataSource.query(
        `INSERT INTO documents (external_id, s3_key, title, status)
         VALUES ($1, $2, 'Estimate scoped', 'needs_review') RETURNING id`,
        [`__route_estimate_doc_${nonce}__`, `documents/${nonce}.pdf`],
      )
      docIds.push(document.id)
      await AppDataSource.query(
        `INSERT INTO document_tags (document_id, tag_id, source, status)
         VALUES ($1, $2, 'llm', 'accepted')`,
        [document.id, tag.id],
      )
      try {
        const response = await estimateReclassifyRoute(
          makeReq(
            'GET',
            `http://localhost/api/admin/topics/reclassify?tagId=${tag.id}`,
            undefined,
            adminCookie,
          ),
        )
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
          ok: true,
          eligible: 1,
          estCost: 0.0008,
        })
        const [job] = await AppDataSource.query(
          `SELECT id FROM reclassify_jobs WHERE document_id = $1`,
          [document.id],
        )
        expect(job).toBeUndefined()
      } finally {
        await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [
          document.id,
        ])
        await AppDataSource.query(`DELETE FROM tags WHERE id = $1`, [tag.id])
      }
    })

    it('POST enqueues an explicit all scope with the exact result shape', async () => {
      const nonce = crypto.randomUUID()
      const [document] = await AppDataSource.query(
        `INSERT INTO documents (external_id, s3_key, title, status)
         VALUES ($1, $2, 'Enqueue all', 'ready') RETURNING id`,
        [`__route_enqueue_all_${nonce}__`, `documents/${nonce}.pdf`],
      )
      docIds.push(document.id)
      let runId: string | undefined
      try {
        const estimateResponse = await estimateReclassifyRoute(
          makeReq(
            'GET',
            'http://localhost/api/admin/topics/reclassify?scope=all',
            undefined,
            adminCookie,
          ),
        )
        const estimate = await estimateResponse.json()
        const response = await enqueueReclassifyRoute(
          makeReq(
            'POST',
            'http://localhost/api/admin/topics/reclassify',
            { scope: 'all' },
            adminCookie,
          ),
        )
        const [ownedJob] = await AppDataSource.query(
          `SELECT run_id FROM reclassify_jobs
           WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [document.id],
        )
        if (ownedJob) {
          runId = ownedJob.run_id
          jobRunIds.push(ownedJob.run_id)
        }

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(ownedJob).toBeDefined()
        expect(body).toEqual({
          ok: true,
          enqueued: estimate.eligible,
          estCost: estimate.estCost,
          runId: ownedJob.run_id,
        })
      } finally {
        if (runId) {
          await AppDataSource.query(
            `DELETE FROM reclassify_jobs WHERE run_id = $1`,
            [runId],
          )
        }
        await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [
          document.id,
        ])
        if (runId) {
          await AppDataSource.query(
            `DELETE FROM audit_log
             WHERE action = 'reclassify_enqueue' AND after->>'runId' = $1`,
            [runId],
          )
        }
      }
    })

    it('POST enqueues an explicit scoped request with the exact result shape', async () => {
      const nonce = crypto.randomUUID()
      const [tag] = await AppDataSource.query(
        `INSERT INTO tags (facet, value_id, taxonomy_version)
         VALUES ('topic', $1, 'v1') RETURNING id`,
        [`__route_enqueue_tag_${nonce}__`],
      )
      tagIds.push(tag.id)
      const [document] = await AppDataSource.query(
        `INSERT INTO documents (external_id, s3_key, title, status)
         VALUES ($1, $2, 'Enqueue scoped', 'needs_review') RETURNING id`,
        [`__route_enqueue_doc_${nonce}__`, `documents/${nonce}.pdf`],
      )
      docIds.push(document.id)
      await AppDataSource.query(
        `INSERT INTO document_tags (document_id, tag_id, source, status)
         VALUES ($1, $2, 'llm', 'accepted')`,
        [document.id, tag.id],
      )
      try {
        const response = await enqueueReclassifyRoute(
          makeReq(
            'POST',
            'http://localhost/api/admin/topics/reclassify',
            { tagId: tag.id },
            adminCookie,
          ),
        )
        expect(response.status).toBe(200)
        const body = await response.json()
        jobRunIds.push(body.runId)
        expect(body).toEqual({
          ok: true,
          enqueued: 1,
          estCost: 0.0008,
          runId: expect.any(String),
        })
        const [job] = await AppDataSource.query(
          `SELECT scope_tag_id FROM reclassify_jobs WHERE document_id = $1`,
          [document.id],
        )
        expect(job.scope_tag_id).toBe(tag.id)
      } finally {
        await AppDataSource.query(
          `DELETE FROM reclassify_jobs WHERE document_id = $1`,
          [document.id],
        )
        await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [
          document.id,
        ])
        await AppDataSource.query(
          `DELETE FROM audit_log
           WHERE action = 'reclassify_enqueue' AND entity_id = $1`,
          [tag.id],
        )
        await AppDataSource.query(`DELETE FROM tags WHERE id = $1`, [tag.id])
      }
    })

    it('POST retries only the requested run and preserves its run id', async () => {
      const nonce = crypto.randomUUID()
      const runId = crypto.randomUUID()
      const [document] = await AppDataSource.query(
        `INSERT INTO documents (external_id, s3_key, title, status)
         VALUES ($1, $2, 'Retry route', 'ready') RETURNING id`,
        [`__route_retry_${nonce}__`, `documents/${nonce}.pdf`],
      )
      docIds.push(document.id)
      jobRunIds.push(runId)
      await AppDataSource.query(
        `INSERT INTO reclassify_jobs
           (document_id, run_id, status, attempts, error)
         VALUES ($1, $2, 'error', 2, 'route retry error')`,
        [document.id, runId],
      )
      try {
        const response = await enqueueReclassifyRoute(
          makeReq(
            'POST',
            'http://localhost/api/admin/topics/reclassify',
            { retryRunId: runId },
            adminCookie,
          ),
        )
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
          ok: true,
          enqueued: 1,
          estCost: 0.0008,
          runId,
        })
        const [job] = await AppDataSource.query(
          `SELECT status, attempts, error FROM reclassify_jobs
           WHERE document_id = $1 AND run_id = $2`,
          [document.id, runId],
        )
        expect(job).toEqual({ status: 'queued', attempts: 0, error: null })
      } finally {
        await AppDataSource.query(
          `DELETE FROM reclassify_jobs WHERE document_id = $1`,
          [document.id],
        )
        await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [
          document.id,
        ])
        await AppDataSource.query(
          `DELETE FROM audit_log WHERE entity_id = $1`,
          [runId],
        )
      }
    })

    it.each([
      ['missing discriminator', {}],
      ['mixed discriminators', { scope: 'all', tagId: crypto.randomUUID() }],
      ['unknown properties', { scope: 'all', extra: true }],
      ['invalid scope', { scope: 'tagged' }],
      ['invalid tag id', { tagId: 'not-a-uuid' }],
      ['invalid retry run id', { retryRunId: 'not-a-uuid' }],
      ['null body', null],
      ['array body', []],
    ])('POST rejects %s with 400', async (_label, body) => {
      const response = await enqueueReclassifyRoute(
        makeReq(
          'POST',
          'http://localhost/api/admin/topics/reclassify',
          body,
          adminCookie,
        ),
      )
      expect(response.status).toBe(400)
    })

    it('POST rejects malformed JSON and an empty body with 400', async () => {
      for (const body of ['{', undefined]) {
        const response = await enqueueReclassifyRoute(
          new NextRequest('http://localhost/api/admin/topics/reclassify', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie: `${SESSION_COOKIE}=${adminCookie}`,
            },
            body,
          }),
        )
        expect(response.status).toBe(400)
      }
    })

    it.each([
      ['missing discriminator', ''],
      ['mixed discriminators', `?scope=all&tagId=${crypto.randomUUID()}`],
      ['unknown parameter', '?scope=all&extra=true'],
      ['invalid scope', '?scope=tagged'],
      ['invalid tag id', '?tagId=not-a-uuid'],
    ])('GET rejects %s with 400', async (_label, query) => {
      const response = await estimateReclassifyRoute(
        makeReq(
          'GET',
          `http://localhost/api/admin/topics/reclassify${query}`,
          undefined,
          adminCookie,
        ),
      )
      expect(response.status).toBe(400)
    })
  })
})
