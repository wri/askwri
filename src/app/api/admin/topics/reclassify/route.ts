import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '@/db/data-source'
import {
  enqueueReclassify,
  estimateReclassify,
  retryReclassifyRun,
} from '@/db/queries/topicsAdmin'
import { requireIdentity } from '@/lib/auth/identity'
import { internalError, isUuid } from '@/lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type EnqueueRequest = { scope: 'all' } | { tagId: string }
type RetryRequest = { retryRunId: string }

function badRequest() {
  return NextResponse.json(
    { ok: false, error: 'invalid reclassification request' },
    { status: 400 },
  )
}

function parseScopeQuery(req: NextRequest): 'all' | { tagId: string } | null {
  const entries = [...req.nextUrl.searchParams.entries()]
  if (entries.length !== 1) return null
  const [[key, value]] = entries
  if (key === 'scope' && value === 'all') return 'all'
  if (key === 'tagId' && isUuid(value)) return { tagId: value }
  return null
}

function parsePostBody(body: unknown): EnqueueRequest | RetryRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null
  }
  const record = body as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1) return null
  if (keys[0] === 'scope' && record.scope === 'all') return { scope: 'all' }
  if (
    keys[0] === 'tagId' &&
    typeof record.tagId === 'string' &&
    isUuid(record.tagId)
  ) {
    return { tagId: record.tagId }
  }
  if (
    keys[0] === 'retryRunId' &&
    typeof record.retryRunId === 'string' &&
    isUuid(record.retryRunId)
  ) {
    return { retryRunId: record.retryRunId }
  }
  return null
}

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  const scope = parseScopeQuery(req)
  if (!scope) return badRequest()
  try {
    await initializeDatabase()
    const result = await estimateReclassify(scope)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return internalError(err)
  }
}

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return badRequest()
  }
  const parsed = parsePostBody(body)
  if (!parsed) return badRequest()

  try {
    await initializeDatabase()
    const result =
      'retryRunId' in parsed
        ? await retryReclassifyRun(parsed.retryRunId, identity!)
        : await enqueueReclassify(
            'scope' in parsed ? 'all' : { tagId: parsed.tagId },
            identity!,
          )
    return NextResponse.json({
      ok: true,
      enqueued: result.enqueued,
      estCost: result.estCost,
      runId: result.runId,
    })
  } catch (err) {
    return internalError(err)
  }
}
