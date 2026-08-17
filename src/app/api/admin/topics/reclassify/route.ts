import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '@/db/data-source'
import { enqueueReclassify } from '@/db/queries/topicsAdmin'
import { requireIdentity } from '@/lib/auth/identity'
import { internalError } from '@/lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const body = (await req.json().catch(() => ({}))) ?? {}
    await initializeDatabase()
    const scope =
      body.scope === 'all' || body.tagId === undefined
        ? 'all'
        : { tagId: String(body.tagId) }
    const result = await enqueueReclassify(scope)
    return NextResponse.json({
      ok: true,
      enqueued: result.enqueued,
      estCost: result.estCost,
      runId: result.runId,
    })
  } catch (err) {
    return internalError(err)
  }
}
