import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '@/db/data-source'
import { listTopicsWithCounts, createTopic } from '@/db/queries/topicsAdmin'
import { requireIdentity } from '@/lib/auth/identity'
import { internalError } from '@/lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    return NextResponse.json({ ok: true, tags: await listTopicsWithCounts() })
  } catch (err) {
    return internalError(err)
  }
}

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const { valueId, description, aliases, parentTagId } =
      (await req.json().catch(() => ({}))) ?? {}
    if (!valueId || !String(valueId).trim()) {
      return NextResponse.json(
        { ok: false, error: 'valueId is required' },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const result = await createTopic(
      {
        valueId: String(valueId),
        description: description as string | undefined | null,
        aliases: Array.isArray(aliases) ? (aliases as string[]) : [],
        parentTagId: parentTagId as string | null | undefined,
      },
      identity!,
    )
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
