import { NextRequest, NextResponse } from 'next/server'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { writeFile, mkdir } from 'fs/promises'
import { join, basename } from 'path'
import { requireIdentity, auditActor } from '../../../../lib/auth/identity'
import { internalError } from '../../../../lib/api-error'
import { s3ClientConfig } from '../../../../lib/s3'
import { initializeDatabase } from '../../../../db/data-source'
import { writeAudit } from '../../../../db/queries/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_FILES = 20
// 50MB deliberately matches the Mistral OCR limit (the qa/prod parse backend
// rejects larger files): anything accepted here that Mistral can't parse
// would fail later as an opaque worker error instead of this friendly 400.
// Raising this requires BOTH a parse-side answer for >50MB files AND a
// matching bump of next.config.js experimental.proxyClientMaxBodySize —
// bodies above THAT cap are truncated by the auth middleware's buffer before
// this route runs and fail as garbled multipart / generic 500 (issue #310).
const MAX_FILE_BYTES = 50 * 1024 * 1024
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // "%PDF-"

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const form = await req.formData()
    const files = form
      .getAll('files')
      .filter((f): f is File => f instanceof File)
    if (files.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'no files provided' },
        { status: 400 },
      )
    }
    if (files.length > MAX_FILES) {
      return NextResponse.json(
        { ok: false, error: `too many files (max ${MAX_FILES})` },
        { status: 400 },
      )
    }
    const bucket = process.env.DOCUMENTS_S3_BUCKET
    const intakePrefix = process.env.INTAKE_S3_PREFIX || 'intake/'
    const localDir = process.env.INTAKE_LOCAL_DIR
    if (!bucket && !localDir) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'no intake destination configured (DOCUMENTS_S3_BUCKET or INTAKE_LOCAL_DIR)',
        },
        { status: 500 },
      )
    }
    // Validate every file (and buffer its bytes once) before uploading any,
    // so a bad file in the batch never leaves a partial upload behind.
    const validated: { name: string; bytes: Uint8Array }[] = []
    const seenNames = new Set<string>()
    for (const file of files) {
      const name = basename(file.name)
      if (!name.toLowerCase().endsWith('.pdf')) {
        return NextResponse.json(
          { ok: false, error: `${name}: only PDFs accepted` },
          { status: 400 },
        )
      }
      if (file.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          {
            ok: false,
            error: `${name}: file too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB)`,
          },
          { status: 400 },
        )
      }
      if (seenNames.has(name)) {
        return NextResponse.json(
          {
            ok: false,
            error: `${name}: duplicate filename in batch (rename and retry)`,
          },
          { status: 400 },
        )
      }
      seenNames.add(name)
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (
        bytes.length < PDF_MAGIC.length ||
        !PDF_MAGIC.every((b, i) => bytes[i] === b)
      ) {
        return NextResponse.json(
          { ok: false, error: `${name}: not a valid PDF` },
          { status: 400 },
        )
      }
      validated.push({ name, bytes })
    }

    const uploaded: string[] = []
    try {
      for (const { name, bytes } of validated) {
        if (bucket) {
          const s3 = new S3Client(s3ClientConfig())
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: `${intakePrefix}${name}`,
              Body: bytes,
            }),
          )
        } else {
          await mkdir(localDir!, { recursive: true })
          await writeFile(join(localDir!, name), bytes)
        }
        uploaded.push(name)
      }
    } catch (uploadErr) {
      // Even on a mid-batch S3 failure, audit the files that DID upload
      // so there is a trail of what landed in intake/.
      if (uploaded.length > 0) {
        await initializeDatabase()
        await writeAudit({
          ...auditActor(identity!),
          action: 'import',
          entityType: 'intake_upload',
          entityId: null,
          after: { files: uploaded, partial: true },
        })
      }
      return internalError(uploadErr)
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
  } catch (err) {
    return internalError(err)
  }
}
