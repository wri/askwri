import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../db/data-source'
import { deleteTagIfUnused } from '../../../../../db/queries/tagsAdmin'
import { requireIdentity } from '../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const { id } = await params
    await initializeDatabase()
    const result = await deleteTagIfUnused(id, identity!)
    if (!result.deleted)
      return NextResponse.json({ ok: false, error: result.error }, { status: 409 })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
