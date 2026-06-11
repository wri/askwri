import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../../db/data-source'
import { decideDocumentTag } from '../../../../../../../db/queries/tagsAdmin'
import { requireIdentity } from '../../../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; tagId: string }> },
) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id, tagId } = await params
    const { decision } = (await req.json().catch(() => ({}))) ?? {}
    if (decision !== 'accepted' && decision !== 'rejected') {
      return NextResponse.json(
        { ok: false, error: "decision must be 'accepted' or 'rejected'" },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const result = await decideDocumentTag(id, tagId, decision, identity!)
    if ('error' in result)
      return NextResponse.json({ ok: false, error: result.error }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
