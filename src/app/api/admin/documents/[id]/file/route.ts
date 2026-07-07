import { NextRequest, NextResponse } from 'next/server'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import { initializeDatabase, AppDataSource } from '../../../../../../db/data-source'
import { Document } from '../../../../../../db/entities/Document.entity'
import { requireIdentity } from '../../../../../../lib/auth/identity'
import { internalError, isUuid } from '../../../../../../lib/api-error'
import { s3ClientConfig } from '../../../../../../lib/s3'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id)) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    await initializeDatabase()
    const doc = await AppDataSource.getRepository(Document).findOne({ where: { id } })
    if (!doc?.s3Key) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })

    // Sanitize: always use the basename of the stored key, then prefix it with
    // the configured documents prefix. This prevents a crafted s3_key from
    // reading arbitrary S3 prefixes (the D3 cross-prefix read fix).
    const filename = basename(doc.s3Key)
    const documentsPrefix = process.env.DOCUMENTS_S3_PREFIX || 'documents/'
    const safeKey = `${documentsPrefix}${filename}`
    const bucket = process.env.DOCUMENTS_S3_BUCKET

    let body: Uint8Array
    if (bucket) {
      const s3 = new S3Client(s3ClientConfig())
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: safeKey }))
      body = new Uint8Array(await obj.Body!.transformToByteArray())
    } else {
      const localDir = process.env.ADMIN_PDF_LOCAL_DIR || join('/tmp', 'askWRI_docs')
      const localPath = join(localDir, filename)
      if (!existsSync(localPath)) {
        return NextResponse.json({ ok: false, error: 'file not found locally' }, { status: 404 })
      }
      body = Uint8Array.from(await readFile(localPath))
    }

    // Status-aware caching: a withdrawn document must not be cached in the
    // editor's browser (it could be re-served after a takedown). Searchable
    // docs can be cached briefly for re-view. (N-G partial fix.)
    const cacheControl = doc.status === 'withdrawn' ? 'no-store' : 'private, max-age=3600'

    return new NextResponse(body as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': cacheControl,
      },
    })
  } catch (err) {
    return internalError(err)
  }
}
