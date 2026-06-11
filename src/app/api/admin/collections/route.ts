import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../db/data-source'
import {
  listCollectionsWithCounts,
  createCollection,
} from '../../../../db/queries/collectionsAdmin'
import { requireIdentity } from '../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    return NextResponse.json({ ok: true, collections: await listCollectionsWithCounts() })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { name, description } = (await req.json().catch(() => ({}))) ?? {}
    if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 })
    await initializeDatabase()
    const result = await createCollection(String(name), description ?? null, identity!)
    if ('error' in result)
      return NextResponse.json({ ok: false, error: result.error }, { status: 409 })
    return NextResponse.json({ ok: true, collection: result })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
