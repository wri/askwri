import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '@/db/data-source'
import { exportDocumentsMetadataCsv } from '@/db/queries/exportDocumentsMetadata'
import { requireIdentity } from '@/lib/auth/identity'
import { internalError } from '@/lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Downloads every document's metadata in the /admin/import template's column
// order, so the file can be edited in a spreadsheet and re-imported as-is.
export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    const csv = await exportDocumentsMetadataCsv()
    const stamp = new Date().toISOString().slice(0, 10)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="askwri-metadata-${stamp}.csv"`,
      },
    })
  } catch (err) {
    return internalError(err)
  }
}
