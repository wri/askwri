import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../db/data-source'
import {
  reviewRelation,
  unlinkRelation,
} from '../../../../../db/queries/documentRelations'
import { requireIdentity, identityName } from '../../../../../lib/auth/identity'
import { internalError } from '../../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ACTIONS = new Set(['confirm', 'reject', 'flip', 'unlink'])

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { response, identity } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    const body = await req.json()
    if (!ACTIONS.has(body?.action)) {
      return NextResponse.json(
        { ok: false, error: 'action must be confirm|reject|flip|unlink' },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const reviewer = identityName(identity)
    const relation =
      body.action === 'unlink'
        ? await unlinkRelation(id, reviewer)
        : await reviewRelation(id, body.action, reviewer)
    if (!relation)
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    return NextResponse.json({ ok: true, relation })
  } catch (err) {
    return internalError(err)
  }
}
