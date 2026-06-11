import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../db/data-source'
import { listAdminDocuments } from '../../../../db/queries/documentsAdmin'
import { requireIdentity } from '../../../../lib/auth/identity'
import { internalError, isUuid } from '../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    const sp = req.nextUrl.searchParams
    const collectionId = sp.get('collectionId') || undefined
    const tagId = sp.get('tagId') || undefined
    if (collectionId && !isUuid(collectionId)) {
      return NextResponse.json({ ok: false, error: 'collectionId must be a UUID' }, { status: 400 })
    }
    if (tagId && !isUuid(tagId)) {
      return NextResponse.json({ ok: false, error: 'tagId must be a UUID' }, { status: 400 })
    }
    await initializeDatabase()
    const items = await listAdminDocuments({
      status: sp.get('status') || undefined,
      language: sp.get('language') || undefined,
      collectionId,
      tagId,
      search: sp.get('search') || undefined,
    })
    return NextResponse.json({ ok: true, items })
  } catch (err) {
    return internalError(err)
  }
}
