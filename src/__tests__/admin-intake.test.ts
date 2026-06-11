/** @jest-environment node */
import { NextRequest } from 'next/server'
import { POST as intakeRoute } from '@/app/api/admin/intake/route'
import { isUuid } from '@/lib/api-error'

beforeAll(() => {
  process.env.ADMIN_API_TOKEN = 'test-admin-token'
  // Give the route a destination so requests reach the per-file checks.
  // All tests below are rejected before anything is written.
  process.env.INTAKE_LOCAL_DIR = '/tmp/askwri-intake-test-never-written'
  delete process.env.DOCUMENTS_S3_BUCKET
})

function intakeReq(files: File[], withAuth = true) {
  const form = new FormData()
  for (const f of files) form.append('files', f)
  const headers: Record<string, string> = withAuth
    ? { authorization: 'Bearer test-admin-token' }
    : {}
  return new NextRequest('http://localhost/api/admin/intake', {
    method: 'POST',
    body: form,
    headers,
  })
}

function pdfNamed(name: string, content: BlobPart = '%PDF-1.7 tiny') {
  return new File([content], name, { type: 'application/pdf' })
}

describe('POST /api/admin/intake limits', () => {
  it('401s without auth', async () => {
    const res = await intakeRoute(intakeReq([pdfNamed('a.pdf')], false))
    expect(res.status).toBe(401)
  })

  it('400s on more than 20 files', async () => {
    const files = Array.from({ length: 21 }, (_, i) => pdfNamed(`f${i}.pdf`))
    const res = await intakeRoute(intakeReq(files))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('too many files')
  })

  it('400s on a file over 50MB before buffering', async () => {
    const big = new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'big.pdf', {
      type: 'application/pdf',
    })
    const res = await intakeRoute(intakeReq([big]))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('big.pdf')
    expect(body.error).toContain('too large')
  })

  it('400s when the content is not a PDF (magic bytes)', async () => {
    const fake = new File(['hello world, definitely not a pdf'], 'fake.pdf', {
      type: 'application/pdf',
    })
    const res = await intakeRoute(intakeReq([fake]))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('fake.pdf')
    expect(body.error).toContain('not a valid PDF')
  })
})

describe('isUuid', () => {
  it('accepts a canonical UUID', () => {
    expect(isUuid('3a0f0e4d-1111-4222-8333-444455556666')).toBe(true)
  })
  it('rejects non-UUID strings', () => {
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid('')).toBe(false)
    expect(isUuid("1' OR '1'='1")).toBe(false)
  })
})
