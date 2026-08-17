import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '@/db/data-source'
import {
  parseTopicsCsv,
  importTopicsDiff,
  applyTopicsImport,
} from '@/db/queries/topicsAdmin'
import { requireIdentity } from '@/lib/auth/identity'
import { internalError } from '@/lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const dryRun = req.nextUrl.searchParams.get('dry_run') === 'true'
    const reclassify = req.nextUrl.searchParams.get('reclassify') === 'true'
    // Accept CSV as text body (Content-Type: text/csv or application/json with "csv" field)
    const contentType = req.headers.get('content-type') ?? ''
    let csvText: string
    if (contentType.includes('application/json')) {
      const body = (await req.json().catch(() => ({}))) ?? {}
      csvText = String(body.csv ?? '')
    } else {
      csvText = await req.text()
    }
    if (!csvText.trim()) {
      return NextResponse.json(
        { ok: false, error: 'CSV body is empty' },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const rows = parseTopicsCsv(csvText)
    if (dryRun) {
      const diff = await importTopicsDiff(rows)
      return NextResponse.json({ ok: true, diff })
    }
    // Apply — atomic: throws on any conflict
    try {
      const result = await applyTopicsImport(rows, reclassify, identity!)
      return NextResponse.json({ ok: true, applied: result.applied })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return NextResponse.json(
        { ok: false, error: msg },
        { status: 409 },
      )
    }
  } catch (err) {
    return internalError(err)
  }
}
