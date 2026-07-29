import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../db/data-source'
import { listDocumentFieldValues } from '../../../../../db/queries/documentsAdmin'
import { requireIdentity } from '../../../../../lib/auth/identity'
import { internalError } from '../../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Feeds the document editor's Article type / WRI primary office dropdowns
// (issue #304) with the values already present in the corpus. A static segment
// outranks the sibling [id] route, so this never reaches getAdminDocumentDetail.
export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    const values = await listDocumentFieldValues()
    return NextResponse.json({ ok: true, ...values })
  } catch (err) {
    return internalError(err)
  }
}
