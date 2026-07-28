import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../db/data-source'
import {
  getAdminDocumentDetail,
  updateDocumentFields,
  purgeDocument,
} from '../../../../../db/queries/documentsAdmin'
import { requireIdentity } from '../../../../../lib/auth/identity'
import { internalError, isUuid } from '../../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id))
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    await initializeDatabase()
    const detail = await getAdminDocumentDetail(id)
    if (!detail)
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    return NextResponse.json({ ok: true, ...detail })
  } catch (err) {
    return internalError(err)
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id))
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    const patch = (await req.json().catch(() => ({}))) ?? {}
    await initializeDatabase()
    const result = await updateDocumentFields(id, patch, identity!)
    if (!result)
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    if ('error' in result)
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 400 },
      )
    return NextResponse.json({ ok: true, updated: result.updated })
  } catch (err) {
    return internalError(err)
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  // Hard-delete: admin-only. Permanently removes the document, its child rows
  // (chunks/summaries/tags/collections), and the S3 PDF. Distinct from withdraw
  // (soft/reversible). Writes an audit tombstone (no reason required).
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id))
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    await initializeDatabase()
    const deleted = await purgeDocument(id, identity!)
    if (!deleted)
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return internalError(err)
  }
}
