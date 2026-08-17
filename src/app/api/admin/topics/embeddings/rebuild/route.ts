import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '@/db/data-source'
import { rebuildTagEmbeddings } from '@/db/queries/topicsAdmin'
import { requireIdentity } from '@/lib/auth/identity'
import { internalError } from '@/lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    await initializeDatabase()
    // Mark all unembedded topic tags for re-embed; the worker's embed sweep
    // (embed_tags.sweep_pending / build_all_embeddings) builds the actual rows.
    // rebuildTagEmbeddings also writes the tag_embeddings_rebuild audit row.
    const { queued } = await rebuildTagEmbeddings(identity!)
    return NextResponse.json({ ok: true, queued })
  } catch (err) {
    return internalError(err)
  }
}
