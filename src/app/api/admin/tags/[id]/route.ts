import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../db/data-source'
import { deleteTagIfUnused, renameTag } from '../../../../../db/queries/tagsAdmin'
import { requireIdentity } from '../../../../../lib/auth/identity'
import { internalError, isUuid } from '../../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id)) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    await initializeDatabase()
    const result = await deleteTagIfUnused(id, identity!)
    if (!result.deleted) {
      const status = result.reason === 'not_found' ? 404 : 409
      return NextResponse.json({ ok: false, error: result.error }, { status })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return internalError(err)
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id)) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    const body = (await req.json().catch(() => ({}))) ?? {}
    const patch: Partial<{ facet: string; valueId: string }> = {}
    if ('facet' in body && body.facet !== undefined) patch.facet = String(body.facet)
    if ('valueId' in body && body.valueId !== undefined) patch.valueId = String(body.valueId)
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ ok: false, error: 'facet or valueId required' }, { status: 400 })
    }
    await initializeDatabase()
    const result = await renameTag(id, patch, identity!)
    if (result === null) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    if ('error' in result) return NextResponse.json({ ok: false, error: result.error }, { status: 400 })
    return NextResponse.json({ ok: true, tag: result })
  } catch (err) {
    return internalError(err)
  }
}
