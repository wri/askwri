import { NextRequest, NextResponse } from 'next/server'
import { AppDataSource, initializeDatabase } from '@/db/data-source'
import { requireIdentity } from '@/lib/auth/identity'
import { internalError } from '@/lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    await initializeDatabase()
    // Set needs_reembed=true for all topic tags lacking an embedding row.
    // The worker's embed sweep (embed_tags.sweep_pending / build_all_embeddings)
    // picks these up and builds the actual embeddings — the app never calls Bedrock.
    const rows: any[] = await AppDataSource.query(
      `UPDATE tags
       SET needs_reembed = true
       WHERE facet = 'topic'
         AND taxonomy_version = 'v1'
         AND NOT EXISTS (
           SELECT 1 FROM tag_embeddings te WHERE te.tag_id = tags.id
         )
       RETURNING id`,
    )
    return NextResponse.json({ ok: true, queued: rows.length })
  } catch (err) {
    return internalError(err)
  }
}
