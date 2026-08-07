/** @jest-environment node */
import { NextRequest } from 'next/server'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { POST as intakeRoute } from '@/app/api/admin/intake/route'
import { POST as addTagRoute } from '@/app/api/admin/documents/[id]/tags/route'
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

  it('400s on a file over 100MB before buffering', async () => {
    const big = new File([new Uint8Array(100 * 1024 * 1024 + 1)], 'big.pdf', {
      type: 'application/pdf',
    })
    const res = await intakeRoute(intakeReq([big]))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('big.pdf')
    expect(body.error).toContain('too large')
  })

  // Intake is excluded from the proxy matcher (src/proxy.ts) so Next never
  // tees its body into memory. That removed an accidental ceiling: the tee
  // stopped pushing chunks past proxyClientMaxBodySize, which crudely bounded
  // what formData() could ever materialize. Nothing bounds it now — and the
  // per-file MAX_FILE_BYTES check cannot, because it runs only after
  // formData() has already built every File in memory. Content-Length is the
  // one bound available before that allocation.
  it('413s on an oversized Content-Length before parsing the body', async () => {
    const req = intakeReq([pdfNamed('a.pdf')])
    req.headers.set('content-length', String(200 * 1024 * 1024))
    const res = await intakeRoute(req)
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.error).toContain('too large')
  })

  it('does not reject a request whose Content-Length is within the cap', async () => {
    const req = intakeReq([pdfNamed('a.pdf')])
    req.headers.set('content-length', String(1024))
    const res = await intakeRoute(req)
    expect(res.status).not.toBe(413)
  })

  it('still parses when Content-Length is absent (chunked upload)', async () => {
    const req = intakeReq([pdfNamed('a.pdf')])
    req.headers.delete('content-length')
    const res = await intakeRoute(req)
    expect(res.status).not.toBe(413)
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

  it('uploads nothing when one file in the batch is oversized', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'askwri-intake-test-'))
    const prevDir = process.env.INTAKE_LOCAL_DIR
    process.env.INTAKE_LOCAL_DIR = dir
    try {
      const good = pdfNamed('good.pdf')
      const big = new File([new Uint8Array(100 * 1024 * 1024 + 1)], 'big.pdf', {
        type: 'application/pdf',
      })
      const res = await intakeRoute(intakeReq([good, big]))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('big.pdf')
      // The valid file must NOT have been written before the batch failed.
      expect(readdirSync(dir)).toEqual([])
    } finally {
      process.env.INTAKE_LOCAL_DIR = prevDir
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('POST /api/admin/documents/[id]/tags body validation', () => {
  it('400s on a non-UUID tagId', async () => {
    const req = new NextRequest(
      'http://localhost/api/admin/documents/3a0f0e4d-1111-4222-8333-444455556666/tags',
      {
        method: 'POST',
        body: JSON.stringify({ tagId: 'not-a-uuid' }),
        headers: { authorization: 'Bearer test-admin-token' },
      },
    )
    const res = await addTagRoute(req, {
      params: Promise.resolve({ id: '3a0f0e4d-1111-4222-8333-444455556666' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('tagId')
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

describe('upload size caps stay consistent', () => {
  // NOTE: proxyClientMaxBodySize no longer governs intake. The route is
  // excluded from the proxy matcher (src/proxy.ts), so Next never tees its
  // body and never truncates it — that was the issue #310 mechanism, and it is
  // gone for this path. MAX_REQUEST_BYTES in the route is what bounds the body
  // now, covered by the Content-Length tests above.
  //
  // The assertion below is kept because the setting still applies to the
  // routes that ARE matched (/api/import-documents takes a JSON row batch),
  // and because a future edit that re-adds intake to the matcher would
  // reintroduce the coupling. It is a floor, not the intake contract.
  const MAX_FILE_BYTES = 100 * 1024 * 1024

  it('proxyClientMaxBodySize exceeds MAX_FILE_BYTES', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nextConfig = require('../../next.config.js')
    const raw = nextConfig.experimental?.proxyClientMaxBodySize as string
    expect(raw).toMatch(/^\d+mb$/)
    const proxyBytes = parseInt(raw, 10) * 1024 * 1024
    expect(proxyBytes).toBeGreaterThan(MAX_FILE_BYTES)
  })

  it('the client mirror matches the server cap', () => {
    const page = readFileSync(
      join(__dirname, '../app/admin/upload/page.tsx'),
      'utf8',
    )
    const route = readFileSync(
      join(__dirname, '../app/api/admin/intake/route.ts'),
      'utf8',
    )
    const capOf = (src: string) =>
      /const MAX_FILE_BYTES = (\d+) \* 1024 \* 1024/.exec(src)?.[1]
    expect(capOf(page)).toBe(capOf(route))
    expect(capOf(route)).toBe(String(MAX_FILE_BYTES / 1024 / 1024))
  })
})
