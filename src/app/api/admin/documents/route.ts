import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../db/data-source'
import {
  listAdminDocuments,
  validateSort,
} from '../../../../db/queries/documentsAdmin'
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
      return NextResponse.json(
        { ok: false, error: 'collectionId must be a UUID' },
        { status: 400 },
      )
    }
    if (tagId && !isUuid(tagId)) {
      return NextResponse.json(
        { ok: false, error: 'tagId must be a UUID' },
        { status: 400 },
      )
    }
    const sort = sp.get('sort') || undefined
    const dir = sp.get('dir') || undefined
    if (!validateSort(sort, dir)) {
      return NextResponse.json(
        { ok: false, error: 'invalid sort or dir' },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const limitStr = sp.get('limit') || undefined
    const offsetStr = sp.get('offset') || undefined
    const limit = limitStr
      ? Math.min(Math.max(parseInt(limitStr, 10) || 500, 1), 500)
      : undefined
    const offset = offsetStr
      ? Math.max(parseInt(offsetStr, 10) || 0, 0)
      : undefined
    const { items, total } = await listAdminDocuments(
      {
        status: sp.get('status') || undefined,
        language: sp.get('language') || undefined,
        collectionId,
        tagId,
        search: sp.get('search') || undefined,
        yearPublished: sp.get('yearPublished')
          ? parseInt(sp.get('yearPublished')!, 10)
          : undefined,
      },
      limit != null || offset != null ? { limit, offset } : {},
      { sort, dir },
    )
    return NextResponse.json({ ok: true, items, total })
  } catch (err) {
    return internalError(err)
  }
}
