import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../db/data-source'
import { setDocumentStatus } from '../../../../../../db/queries/documentsAdmin'
import { requireIdentity } from '../../../../../../lib/auth/identity'
import { triggerReindex } from '../../../../../../lib/search-reindex'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    await initializeDatabase()
    const result = await setDocumentStatus(id, toStatus, identity!)
    if (!result) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    if ('error' in result)
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 })
    // Both directions need a BM25 refresh: the in-memory BM25 index only
    // tracks status='searchable' rows as of the last boot//reindex.
    const reindex = await triggerReindex()
    return NextResponse.json({
      ok: true,
      fromStatus: result.fromStatus,
      status: toStatus,
      reindex,
    })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
