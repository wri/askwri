import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../db/data-source'
import { getReviewQueue } from '../../../../db/queries/reviewQueue'
import { requireIdentity } from '../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    const items = await getReviewQueue()
    return NextResponse.json({ ok: true, items })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
