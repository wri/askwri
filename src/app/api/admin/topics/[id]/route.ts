import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '@/db/data-source'
import {
  getTopic,
  updateTopic,
  deleteTopicIfUnused,
} from '@/db/queries/topicsAdmin'
import { requireIdentity } from '@/lib/auth/identity'
import { internalError, isUuid } from '@/lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id))
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    await initializeDatabase()
    const tag = await getTopic(id)
    if (!tag)
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    return NextResponse.json({ ok: true, tag })
  } catch (err) {
    return internalError(err)
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id))
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    const body = (await req.json().catch(() => ({}))) ?? {}
    await initializeDatabase()
    const result = await updateTopic(
      id,
      {
        valueId: body.valueId !== undefined ? String(body.valueId) : undefined,
        description: body.description,
        aliases: Array.isArray(body.aliases) ? body.aliases : undefined,
        parentTagId: body.parentTagId,
      },
      identity!,
    )
    if (result === null)
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
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

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id))
      return NextResponse.json(
        { ok: false, error: 'not found' },
        { status: 404 },
      )
    await initializeDatabase()
    const result = await deleteTopicIfUnused(id, identity!)
    if (!result.deleted) {
      const status = result.reason === 'not_found' ? 404 : 409
      return NextResponse.json({ ok: false, error: result.error }, { status })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return internalError(err)
  }
}
