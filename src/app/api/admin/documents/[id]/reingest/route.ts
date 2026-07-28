import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../db/data-source'
import { reenqueueIngestion } from '../../../../../../db/queries/documentsAdmin'
import { requireIdentity } from '../../../../../../lib/auth/identity'
import { internalError, isUuid } from '../../../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id))
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    await initializeDatabase()
    const result = await reenqueueIngestion(id, identity!)
    if (!result)
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    if ('error' in result)
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 409 },
      )
    return NextResponse.json({ ok: true, jobId: result.jobId })
  } catch (err) {
    return internalError(err)
  }
}
