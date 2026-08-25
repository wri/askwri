import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../db/data-source'
import { importDocuments } from '../../../db/queries/importDocuments'
import { requireIdentity } from '../../../lib/auth/identity'
import { internalError } from '../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // D3 fix: admin-only — was requireIdentity(req) with no role arg (any editor
  // could bulk-import and craft s3_key values for cross-prefix S3 reads).
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const body = await req.json()
    const { rows, dryRun = false } = body ?? {}

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'rows must be a non-empty array' },
        { status: 400 },
      )
    }

    await initializeDatabase()
    const result = await importDocuments(rows, { dryRun }, identity)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return internalError(err)
  }
}
