import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, AppDataSource } from '../../../../../db/data-source'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const externalId = decodeURIComponent(id)

    if (!externalId) {
      return NextResponse.json({ ok: false, error: 'missing id' }, { status: 400 })
    }

    await initializeDatabase()

    const rows = await AppDataSource.query(
      `
        WITH current_doc AS (
          SELECT id, external_id, language, url, status
          FROM documents
          WHERE external_id = $1
          LIMIT 1
        ),
        current_is_translation AS (
          SELECT EXISTS (
            SELECT 1
            FROM document_relations r
            JOIN current_doc c ON c.id = r.document_id
            WHERE r.status = 'confirmed'
              AND r.relation_type = 'translation_of'
          ) AS flag
        ),
        related AS (
          SELECT d.id, d.external_id, d.language, d.url, d.status, false AS is_original
          FROM document_relations r
          JOIN documents d ON d.id = r.document_id
          JOIN current_doc c ON c.id = r.related_document_id
          WHERE r.status = 'confirmed'
            AND r.relation_type = 'translation_of'
            AND d.status = 'searchable'

          UNION

          SELECT d.id, d.external_id, d.language, d.url, d.status, true AS is_original
          FROM document_relations r
          JOIN documents d ON d.id = r.related_document_id
          JOIN current_doc c ON c.id = r.document_id
          WHERE r.status = 'confirmed'
            AND r.relation_type = 'translation_of'
            AND d.status = 'searchable'

          UNION

          SELECT c.id, c.external_id, c.language, c.url, c.status,
                 NOT (SELECT flag FROM current_is_translation) AS is_original
          FROM current_doc c
        )
        SELECT DISTINCT external_id AS "externalId",
                        language,
                        COALESCE(url, '/api/pdf/' || external_id) AS url,
                        is_original AS "isOriginal"
        FROM related
        WHERE status = 'searchable'
        ORDER BY language NULLS LAST, external_id
      `,
      [externalId],
    )

    return NextResponse.json({
      ok: true,
      versions: rows.map((row: any) => ({
        language: row.language || 'Document',
        url: row.url,
        externalId: row.externalId,
        isOriginal: !!row.isOriginal,
      })),
    })
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'failed to load versions' },
      { status: 500 },
    )
  }
}
