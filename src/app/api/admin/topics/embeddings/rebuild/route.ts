import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '@/db/data-source'
import {
  rebuildTagEmbeddings,
  embeddingsProgress,
} from '@/db/queries/topicsAdmin'
import { requireIdentity } from '@/lib/auth/identity'
import { internalError } from '@/lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET — read-only progress of the tag-embed worker sweep. Returns
 * { ok, total, embedded, pending }. Used by the Rebuild panel to show
 * "is the sweep done?" after a big import or Rebuild.
 */
export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    return NextResponse.json({ ok: true, ...(await embeddingsProgress()) })
  } catch (err) {
    return internalError(err)
  }
}

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    await initializeDatabase()
    // Mark all unembedded topic tags for re-embed; the worker's embed sweep
    // (embed_tags.sweep_pending / build_all_embeddings) builds the actual rows.
    // rebuildTagEmbeddings writes the flag changes and audit row atomically.
    const { queued } = await rebuildTagEmbeddings(identity!)
    return NextResponse.json({ ok: true, queued })
  } catch (err) {
    return internalError(err)
  }
}
