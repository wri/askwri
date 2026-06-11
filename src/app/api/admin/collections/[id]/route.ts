import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../db/data-source'
import { updateCollection } from '../../../../../db/queries/collectionsAdmin'
import { requireIdentity } from '../../../../../lib/auth/identity'
import { internalError, isUuid } from '../../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id)) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    const body = (await req.json().catch(() => ({}))) ?? {}
    const patch: Partial<{ name: string; description: string | null }> = {}
    if ('name' in body && body.name !== undefined) patch.name = body.name
    if ('description' in body && body.description !== undefined) patch.description = body.description
    await initializeDatabase()
    const result = await updateCollection(id, patch, identity!)
    if (result === null)
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    return NextResponse.json({ ok: true, collection: result })
  } catch (err) {
    return internalError(err)
  }
}
