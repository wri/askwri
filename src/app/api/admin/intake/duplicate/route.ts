import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../db/data-source'
import { findIntakeDuplicate } from '../../../../../db/queries/intakeDuplicate'
import { requireIdentity } from '../../../../../lib/auth/identity'
import { internalError } from '../../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// NOTE: this path sits UNDER /api/admin/intake but is a distinct route, so the
// proxy matcher's `(?!intake$)` exemption does not cover it — the `$` anchors
// the exclusion to the bare intake endpoint. That is correct: this route takes
// no body, so the proxy's body tee costs nothing here, and it keeps the
// exemption as narrow as possible.
export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  const filename = req.nextUrl.searchParams.get('filename')
  if (!filename) {
    return NextResponse.json(
      { ok: false, error: 'filename is required' },
      { status: 400 },
    )
  }
  try {
    await initializeDatabase()
    const duplicate = await findIntakeDuplicate(filename)
    return NextResponse.json({ ok: true, duplicate })
  } catch (err) {
    return internalError(err)
  }
}
