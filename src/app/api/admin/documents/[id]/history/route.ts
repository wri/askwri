import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../db/data-source'
import { getDocumentHistory } from '../../../../../../db/queries/documentHistory'
import { requireIdentity } from '../../../../../../lib/auth/identity'
import { internalError, isUuid } from '../../../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

// GET /api/admin/documents/[id]/history?limit=20&offset=0
export async function GET(req: NextRequest, { params }: Params) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id))
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    const params_ = req.nextUrl.searchParams
    const limit = Math.min(Math.max(Number(params_.get('limit')) || 20, 1), 500)
    const offset = Math.max(Number(params_.get('offset')) || 0, 0)
    await initializeDatabase()
    return NextResponse.json({
      ok: true,
      ...(await getDocumentHistory(id, { limit, offset })),
    })
  } catch (err) {
    return internalError(err)
  }
}
