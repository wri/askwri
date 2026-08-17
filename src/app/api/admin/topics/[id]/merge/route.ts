import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '@/db/data-source'
import { mergeTags, enqueueReclassify } from '@/db/queries/topicsAdmin'
import { requireIdentity } from '@/lib/auth/identity'
import { internalError, isUuid } from '@/lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const { id: fromId } = await params
    if (!isUuid(fromId))
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    const { intoTagId } = (await req.json().catch(() => ({}))) ?? {}
    if (!intoTagId || !isUuid(String(intoTagId)))
      return NextResponse.json(
        { ok: false, error: 'intoTagId is required' },
        { status: 400 },
      )
    await initializeDatabase()
    const result = await mergeTags(String(intoTagId), fromId, identity!)
    if ('error' in result)
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 409 },
      )
    // Enqueue scoped re-classify on the survivor tag after a successful merge
    await enqueueReclassify({ tagId: String(intoTagId) }, identity!)
    return NextResponse.json({ ok: true, moved: result.moved })
  } catch (err) {
    return internalError(err)
  }
}
