/** @jest-environment node */
import { NextRequest } from 'next/server'
import { AppDataSource } from '@/db/data-source'
import { GET, POST } from '@/app/api/admin/relations/route'
import { PATCH } from '@/app/api/admin/relations/[id]/route'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('admin relations routes', () => {
  const ext = `relroutes_test_${Date.now()}`
  let docA: string
  let docB: string
  let docC: string
  let seededRelId: string
  let manualRelId: string | null = null

  beforeAll(async () => {
    process.env.ADMIN_API_TOKEN = 'test-admin-token'
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const rows = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status) VALUES
       ($1, $2, 'Routes A', 'searchable'),
       ($3, $4, 'Routes B', 'searchable'),
       ($5, $6, 'Routes C', 'searchable') RETURNING id`,
      [
        `${ext}_a`,
        `documents/${ext}_a.pdf`,
        `${ext}_b`,
        `documents/${ext}_b.pdf`,
        `${ext}_c`,
        `documents/${ext}_c.pdf`,
      ],
    )
    docA = rows[0].id
    docB = rows[1].id
    docC = rows[2].id
    const [rel] = await AppDataSource.query(
      `INSERT INTO document_relations (document_id, related_document_id, source, status, confidence, signals)
       VALUES ($1, $2, 'system', 'suggested', 0.93, '{"trigger":"title"}') RETURNING id`,
      [docA, docB],
    )
    seededRelId = rel.id
  })

  afterAll(async () => {
    const auditIds = [seededRelId, manualRelId].filter(Boolean) as string[]
    if (auditIds.length) {
      await AppDataSource.query(
        `DELETE FROM audit_log WHERE entity_type = 'document_relation' AND entity_id = ANY($1::uuid[])`,
        [auditIds],
      )
    }
    await AppDataSource.query(
      `DELETE FROM document_relations WHERE document_id IN ($1, $2, $3) OR related_document_id IN ($1, $2, $3)`,
      [docA, docB, docC],
    )
    await AppDataSource.query(
      `DELETE FROM documents WHERE id IN ($1, $2, $3)`,
      [docA, docB, docC],
    )
    await AppDataSource.destroy()
  })

  function authHeaders() {
    return { authorization: 'Bearer test-admin-token' }
  }

  it('GET returns the seeded suggestion', async () => {
    const req = new NextRequest(
      'http://localhost/api/admin/relations?status=suggested',
      { method: 'GET', headers: authHeaders() },
    )
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.relations.some((r: any) => r.id === seededRelId)).toBe(true)
  })

  it('PATCH confirm returns the confirmed row', async () => {
    const req = new NextRequest(
      `http://localhost/api/admin/relations/${seededRelId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action: 'confirm' }),
        headers: authHeaders(),
      },
    )
    const res = await PATCH(req, {
      params: Promise.resolve({ id: seededRelId }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.relation.status).toBe('confirmed')
  })

  it('PATCH bad action returns 400', async () => {
    const req = new NextRequest(
      `http://localhost/api/admin/relations/${seededRelId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action: 'bogus' }),
        headers: authHeaders(),
      },
    )
    const res = await PATCH(req, {
      params: Promise.resolve({ id: seededRelId }),
    })
    expect(res.status).toBe(400)
  })

  it('PATCH unknown uuid returns 404', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000'
    const req = new NextRequest(
      `http://localhost/api/admin/relations/${unknown}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action: 'confirm' }),
        headers: authHeaders(),
      },
    )
    const res = await PATCH(req, { params: Promise.resolve({ id: unknown }) })
    expect(res.status).toBe(404)
  })

  it('POST creates a confirmed manual link', async () => {
    const req = new NextRequest('http://localhost/api/admin/relations', {
      method: 'POST',
      body: JSON.stringify({ translationDocId: docC, originalDocId: docB }),
      headers: authHeaders(),
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.relation.status).toBe('confirmed')
    expect(body.relation.source).toBe('human')
    manualRelId = body.relation.id
  })
})
