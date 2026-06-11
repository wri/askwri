import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../db/data-source'
import { addHumanTag } from '../../../../../../db/queries/tagsAdmin'
import { requireIdentity } from '../../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    const { tagId } = (await req.json().catch(() => ({}))) ?? {}
    if (!tagId) return NextResponse.json({ ok: false, error: 'tagId is required' }, { status: 400 })
    await initializeDatabase()
    const result = await addHumanTag(id, String(tagId), identity!)
    if ('error' in result)
      return NextResponse.json({ ok: false, error: result.error }, { status: 409 })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
