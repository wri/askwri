import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../db/data-source'
import { updateDocumentSummary } from '../../../../../../db/queries/documentsAdmin'
import { requireIdentity } from '../../../../../../lib/auth/identity'
import { internalError } from '../../../../../../lib/api-error'
import { isUuid } from '../../../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id)) return NextResponse.json({ ok: false, error: 'invalid id' }, { status: 400 })
    const body = await req.json().catch(() => ({}))
    const { language, kind, text } = body ?? {}
    if (!language || !kind || typeof text !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'language, kind, and text are required' },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const result = await updateDocumentSummary(id, language, kind, text, identity!)
    if (result === null) {
      return NextResponse.json({ ok: false, error: 'summary not found' }, { status: 404 })
    }
    if ('error' in result) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 })
    }
    return NextResponse.json({ ok: true, updated: result.updated })
  } catch (err) {
    return internalError(err)
  }
}
