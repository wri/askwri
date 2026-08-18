import { NextRequest, NextResponse } from 'next/server'
import { AppDataSource } from '@/db/data-source'
import { initializeDatabase } from '@/db/data-source'
import { requireIdentity } from '@/lib/auth/identity'
import { internalError } from '@/lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET /api/admin/topics/:id/documents — list documents tagged with this tag.
 * Returns id, title, title_en, external_id, status, and the tag's
 * source (human/external/llm) + confidence for this document. */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    const rows = await AppDataSource.query(
      `SELECT d.id, d.title, d.title_en AS "titleEn", d.external_id AS "externalId",
              d.status, dt.source, dt.confidence
       FROM document_tags dt
       JOIN documents d ON d.id = dt.document_id
       WHERE dt.tag_id = $1
       ORDER BY d.title_en, d.title`,
      [params.id],
    )
    return NextResponse.json({ ok: true, documents: rows })
  } catch (err) {
    return internalError(err)
  }
}
