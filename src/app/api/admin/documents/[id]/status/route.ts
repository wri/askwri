import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../db/data-source'
import { setDocumentStatus } from '../../../../../../db/queries/documentsAdmin'
import { requireIdentity } from '../../../../../../lib/auth/identity'
import { internalError, isUuid } from '../../../../../../lib/api-error'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const body = (await req.json().catch(() => ({}))) ?? {}
  const toStatus = String(body.status || '')
  // Withdraw is a takedown — admin only. Promote (-> searchable) is the
  // review queue's whole purpose and stays editor-accessible.
  const { identity, response } = await requireIdentity(
    req,
    toStatus === 'withdrawn' ? 'admin' : undefined,
  )
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id))
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    await initializeDatabase()
    const result = await setDocumentStatus(id, toStatus, identity!)
    if (!result)
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    if ('forbidden' in result)
      return NextResponse.json(
        { ok: false, error: 'forbidden' },
        { status: 403 },
      )
    if ('error' in result)
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 400 },
      )
    // Keyword + dense lanes both filter status='searchable' per query (KEYWORD_BACKEND=sparse) — no reindex choreography.
    if (toStatus === 'searchable') {
      // Fire-and-forget: refreshes the search service's in-memory passage-context
      // texts only (document_texts load at boot//reindex, filtered to searchable).
      // /reindex is build-then-swap and coalesces concurrent calls via 409 — safe
      // to fire blind without awaiting.
      const searchServiceUrl =
        process.env.SEARCH_SERVICE_URL || process.env.LLAMAINDEX_SERVICE_URL
      if (searchServiceUrl) {
        void fetch(`${searchServiceUrl}/reindex`, { method: 'POST' }).catch(
          () => {},
        )
      }
    }
    return NextResponse.json({
      ok: true,
      fromStatus: result.fromStatus,
      status: toStatus,
    })
  } catch (err) {
    return internalError(err)
  }
}
