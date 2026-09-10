import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../db/data-source'
import { insertExpertsModeQueryLog } from '../../../db/queries/insertExpertsModeQueryLog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  await initializeDatabase()
  try {
    const body = await req.json()
    const query = typeof body?.query === 'string' ? body.query.trim() : ''
    const mode = body?.mode === 'topic_only' ? 'topic_only' : 'evidence'
    const topTenPeople =
      typeof body?.topTenPeople === 'string' ? body.topTenPeople : '[]'
    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 })
    }
    const record = await insertExpertsModeQueryLog({
      query,
      mode,
      topTenPeople,
    })
    return NextResponse.json(record, { status: 201 })
  } catch (error) {
    console.error('❌ Error inserting experts query log:', error)
    return NextResponse.json(
      { error: 'Error inserting query' },
      { status: 500 },
    )
  }
}
