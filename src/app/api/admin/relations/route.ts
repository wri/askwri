import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../db/data-source'
import { listRelations, createManualRelation } from '../../../../db/queries/documentRelations'
import { requireIdentity, identityName } from '../../../../lib/auth/identity'
import { internalError } from '../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    const status = req.nextUrl.searchParams.get('status') ?? undefined
    const relations = await listRelations(status)
    return NextResponse.json({ ok: true, relations })
  } catch (err) {
    return internalError(err)
  }
}

export async function POST(req: NextRequest) {
  const { response, identity } = await requireIdentity(req)
  if (response) return response
  try {
    const body = await req.json()
    if (!body?.translationDocId || !body?.originalDocId) {
      return NextResponse.json({ ok: false, error: 'translationDocId and originalDocId are required' }, { status: 400 })
    }
    await initializeDatabase()
    const relation = await createManualRelation(
      body.translationDocId, body.originalDocId, identityName(identity))
    return NextResponse.json({ ok: true, relation })
  } catch (err) {
    return internalError(err)
  }
}
