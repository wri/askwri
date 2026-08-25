import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../db/data-source'
import { getCorpusHealth } from '../../../../db/queries/corpusHealth'
import { requireIdentity } from '../../../../lib/auth/identity'
import { internalError } from '../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    const health = await getCorpusHealth()
    return NextResponse.json({ ok: true, health })
  } catch (err) {
    return internalError(err)
  }
}
