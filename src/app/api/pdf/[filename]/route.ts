import { NextRequest, NextResponse } from 'next/server'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { initializeDatabase } from '../../../../db/data-source'
import { getDocumentForPdf } from '../../../../db/queries/getDocumentForPdf'
import { s3ClientConfig } from '../../../../lib/s3'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  try {
    const { filename } = await params

    // Security: only PDF files, no directory traversal.
    if (
      !filename.endsWith('.pdf') ||
      filename.includes('..') ||
      filename.includes('/')
    ) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 })
    }

    // Look up the document by external_id (the filename without .pdf).
    // This is the source of truth — the DB holds the real s3_key and status.
    await initializeDatabase()
    const externalId = filename.replace(/\.pdf$/i, '')
    const doc = await getDocumentForPdf(externalId)

    // Not found or withdrawn → 404 (withdrawn docs must not be served publicly).
    if (!doc || doc.status === 'withdrawn') {
      return NextResponse.json(
        { error: 'PDF not found', filename },
        { status: 404 },
      )
    }

    // Serve from S3 via doc.s3Key — works under any DOCUMENTS_S3_PREFIX because
    // the key is the actual stored value (bare filename for migrated docs,
    // "documents/<name>.pdf" for worker-ingested docs). This eliminates the
    // R5 boot-sync gap: no dependency on /tmp/askWRI_docs being populated.
    const bucket = process.env.DOCUMENTS_S3_BUCKET
    if (bucket) {
      try {
        const s3 = new S3Client(s3ClientConfig())
        const obj = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: doc.s3Key }),
        )
        if (!obj.Body) throw new Error('S3 object body is empty')
        const body = new Uint8Array(await obj.Body.transformToByteArray())
        return new NextResponse(body as BodyInit, {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="${filename}"`,
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        })
      } catch (s3Err) {
        // S3 fetch failed — fall through to local filesystem (dev fallback).
        console.error(
          `PDF S3 fetch failed for "${doc.s3Key}" — trying local fallback:`,
          s3Err,
        )
      }
    }

    // Local filesystem fallback (dev: /tmp/askWRI_docs is a symlink to
    // search-service/data). Used only when DOCUMENTS_S3_BUCKET is unset or
    // the S3 fetch failed.
    const pdfPath = join('/tmp', 'askWRI_docs', filename)
    if (!existsSync(pdfPath)) {
      return NextResponse.json(
        { error: 'PDF not found', filename },
        { status: 404 },
      )
    }
    const pdfBuffer = await readFile(pdfPath)
    return new NextResponse(Uint8Array.from(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch (error: any) {
    console.error('Error serving PDF:', error)
    return NextResponse.json(
      { error: 'Failed to serve PDF', message: error.message },
      { status: 500 },
    )
  }
}
