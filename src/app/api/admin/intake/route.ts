import { NextRequest, NextResponse } from 'next/server'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { writeFile, mkdir } from 'fs/promises'
import { join, basename } from 'path'
import { requireIdentity, auditActor } from '../../../../lib/auth/identity'
import { initializeDatabase } from '../../../../db/data-source'
import { writeAudit } from '../../../../db/queries/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const form = await req.formData()
    const files = form.getAll('files').filter((f): f is File => f instanceof File)
    if (files.length === 0) {
      return NextResponse.json({ ok: false, error: 'no files provided' }, { status: 400 })
    }
    const bucket = process.env.DOCUMENTS_S3_BUCKET
    const intakePrefix = process.env.INTAKE_S3_PREFIX || 'intake/'
    const localDir = process.env.INTAKE_LOCAL_DIR
    if (!bucket && !localDir) {
      return NextResponse.json(
        { ok: false, error: 'no intake destination configured (DOCUMENTS_S3_BUCKET or INTAKE_LOCAL_DIR)' },
        { status: 500 },
      )
    }
    const uploaded: string[] = []
    for (const file of files) {
      const name = basename(file.name)
      if (!name.toLowerCase().endsWith('.pdf')) {
        return NextResponse.json({ ok: false, error: `${name}: only PDFs accepted` }, { status: 400 })
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bucket) {
        const s3 = new S3Client({})
        await s3.send(
          new PutObjectCommand({ Bucket: bucket, Key: `${intakePrefix}${name}`, Body: bytes }),
        )
      } else {
        await mkdir(localDir!, { recursive: true })
        await writeFile(join(localDir!, name), bytes)
      }
      uploaded.push(name)
    }
    await initializeDatabase()
    await writeAudit({
      ...auditActor(identity!),
      action: 'import',
      entityType: 'intake_upload',
      entityId: null,
      after: { files: uploaded },
    })
    return NextResponse.json({ ok: true, uploaded })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
