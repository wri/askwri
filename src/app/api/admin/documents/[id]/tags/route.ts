import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../db/data-source'
import { addHumanTag } from '../../../../../../db/queries/tagsAdmin'
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
    const { tagId } = (await req.json().catch(() => ({}))) ?? {}
    if (!tagId)
      return NextResponse.json(
        { ok: false, error: 'tagId is required' },
        { status: 400 },
      )
    if (!isUuid(String(tagId)))
      return NextResponse.json(
        { ok: false, error: 'tagId must be a UUID' },
        { status: 400 },
      )
    await initializeDatabase()
    const result = await addHumanTag(id, String(tagId), identity!)
    if ('error' in result)
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 409 },
      )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return internalError(err)
  }
}
