import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../db/data-source'
import { listTagsWithCounts, createTag } from '../../../../db/queries/tagsAdmin'
import { requireIdentity } from '../../../../lib/auth/identity'
import { internalError } from '../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    return NextResponse.json({ ok: true, tags: await listTagsWithCounts() })
  } catch (err) {
    return internalError(err)
  }
}

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { facet, valueId, allowNewFacet } =
      (await req.json().catch(() => ({}))) ?? {}
    if (!facet || !valueId) {
      return NextResponse.json(
        { ok: false, error: 'facet and valueId are required' },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const result = await createTag(String(facet), String(valueId), identity!, {
      allowNewFacet: Boolean(allowNewFacet),
    })
    if ('error' in result)
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 409 },
      )
    return NextResponse.json({ ok: true, tag: result })
  } catch (err) {
    return internalError(err)
  }
}
