import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../db/data-source'
import { listAdminDocuments } from '../../../../db/queries/documentsAdmin'
import { requireIdentity } from '../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    const sp = req.nextUrl.searchParams
    const items = await listAdminDocuments({
      status: sp.get('status') || undefined,
      language: sp.get('language') || undefined,
      collectionId: sp.get('collectionId') || undefined,
      tagId: sp.get('tagId') || undefined,
      search: sp.get('search') || undefined,
    })
    return NextResponse.json({ ok: true, items })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
