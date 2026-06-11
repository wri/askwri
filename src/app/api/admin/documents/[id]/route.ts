import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../db/data-source'
import {
  getAdminDocumentDetail,
  updateDocumentFields,
} from '../../../../../db/queries/documentsAdmin'
import { requireIdentity } from '../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    await initializeDatabase()
    const detail = await getAdminDocumentDetail(id)
    if (!detail) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    return NextResponse.json({ ok: true, ...detail })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    const patch = (await req.json().catch(() => ({}))) ?? {}
    await initializeDatabase()
    const result = await updateDocumentFields(id, patch, identity!)
    if (!result) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    return NextResponse.json({ ok: true, updated: result.updated })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
