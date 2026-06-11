import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../db/data-source'
import {
  addDocumentsToCollection,
  removeDocumentFromCollection,
} from '../../../../../../db/queries/collectionsAdmin'
import { requireIdentity } from '../../../../../../lib/auth/identity'
import { internalError, isUuid } from '../../../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id)) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    const { documentIds } = (await req.json().catch(() => ({}))) ?? {}
    if (!Array.isArray(documentIds) || documentIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'documentIds must be a non-empty array' },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const result = await addDocumentsToCollection(id, documentIds, identity!)
    if ('error' in result) {
      const status = result.error === 'documentIds must be UUIDs' ? 400 : 404
      return NextResponse.json({ ok: false, error: result.error }, { status })
    }
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return internalError(err)
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id)) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    const { documentId } = (await req.json().catch(() => ({}))) ?? {}
    if (!documentId)
      return NextResponse.json({ ok: false, error: 'documentId is required' }, { status: 400 })
    await initializeDatabase()
    await removeDocumentFromCollection(id, String(documentId), identity!)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return internalError(err)
  }
}
